/**
 * Coordinates one run from start to finish: lifecycle, sandbox, clone, agent,
 * patch capture, kill switch, and the record of what the sandbox cost.
 *
 * The router and supervisor are not built yet (steps 6 and 7), so those
 * stages are passed through and say so in the event log.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Sandbox, SandboxProvider } from "../sandbox-provider/types.ts";
import type { RunStatus } from "./state.ts";
import { signRunToken } from "./tokens.ts";

const REPO_DIR = "/workspace/repo";
const AGENT_DIR = "/agent";
const AGENT_SOURCE = join(import.meta.dirname, "..", "agent");
const KILL_POLL_MS = 1000;

export interface RunDeps {
  db: Db;
  sandboxes: SandboxProvider;
  config: Config;
}

/** Thrown when the owner has asked for the run to stop. */
class Killed extends Error {}
/** Thrown when the gateway refused the agent because the month's budget is spent. */
class BudgetStopped extends Error {}

/** Copies the agent's source files into the sandbox. */
async function installAgent(sandbox: Sandbox): Promise<number> {
  await sandbox.exec(["mkdir", "-p", AGENT_DIR]);
  const files = (await readdir(AGENT_SOURCE)).filter((name) => name.endsWith(".ts"));
  for (const name of files) {
    await sandbox.writeFile(`${AGENT_DIR}/${name}`, await readFile(join(AGENT_SOURCE, name), "utf8"));
  }
  return files.length;
}

export async function executeRun(deps: RunDeps, runId: string): Promise<void> {
  const { db, sandboxes, config } = deps;
  let sandbox: Sandbox | null = null;
  let cloned = false;

  const move = (to: RunStatus, error?: string) => {
    db.setStatus(runId, to, error);
    db.appendEvent(runId, "status", { status: to, ...(error ? { error } : {}) });
  };
  const killRequested = () => db.getRun(runId)?.killRequested === true;
  const checkKill = () => {
    if (killRequested()) throw new Killed();
  };
  const capturePatch = async () => {
    if (!sandbox || !cloned) return;
    // --intent-to-add makes brand-new files show up in the diff as well.
    await sandbox.exec(["git", "add", "--intent-to-add", "."], { workdir: REPO_DIR });
    const diff = await sandbox.exec(["git", "diff"], { workdir: REPO_DIR });
    db.savePatch(runId, diff.stdout);
    db.appendEvent(runId, "patch_captured", { bytes: diff.stdout.length });
  };

  /** Runs the agent in the sandbox, storing its events as they arrive. */
  const runAgent = async (box: Sandbox, task: string): Promise<string> => {
    const expiresAt = Math.floor(Date.now() / 1000) + config.runTokenTtlSeconds;
    let reason = "agent_crashed";
    const agent = box.exec(["node", "--experimental-strip-types", "--no-warnings", `${AGENT_DIR}/main.ts`], {
      workdir: REPO_DIR,
      timeoutSeconds: config.agentTimeoutSeconds,
      env: {
        GATEWAY_URL: config.gatewayUrl,
        // The only credential in the sandbox: valid for this run, briefly, as "worker".
        RUN_PASS: signRunToken(config.gatewayKey, runId, expiresAt),
        TASK: task,
        REPO_DIR,
        MAX_STEPS: String(config.agentMaxSteps),
      },
      onStdoutLine: (line) => {
        try {
          const { type, ...data } = JSON.parse(line) as { type: string; reason?: string };
          if (type === "finished" && data.reason) reason = data.reason;
          db.appendEvent(runId, `agent_${type}`, data);
        } catch {
          if (line.trim()) db.appendEvent(runId, "agent_output", { line: line.slice(0, 500) });
        }
      },
    });
    // A kill must not wait for the agent's current step, so watch for it alongside.
    let watching = true;
    const killed = (async () => {
      while (watching) {
        if (killRequested()) throw new Killed();
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS));
      }
    })();
    try {
      const result = await Promise.race([agent, killed.then(() => null)]);
      if (result?.timedOut) reason = "timeout";
      else if (result && result.exitCode !== 0 && reason === "agent_crashed") {
        db.appendEvent(runId, "agent_output", { stderr: result.stderr.slice(-500) });
      }
    } finally {
      watching = false;
      agent.catch(() => {}); // if killed, the sandbox is destroyed underneath it
    }
    return reason;
  };

  try {
    const run = db.getRun(runId);
    if (!run) throw new Error(`No run ${runId}`);

    move("triaging");
    const assignment = { tier: "small", decidedBy: "default", reason: "Router not built yet (step 6)." };
    db.addAssignment(runId, assignment);
    db.appendEvent(runId, "routing", assignment);
    checkKill();

    move("running");
    const createStarted = Date.now();
    sandbox = await sandboxes.create({ runId, maxLifetimeSeconds: config.sandboxMaxLifetimeSeconds });
    db.appendEvent(runId, "sandbox_created", {
      sandboxId: sandbox.id,
      seconds: (Date.now() - createStarted) / 1000,
    });
    checkKill();

    const clone = await sandbox.exec(["git", "clone", "--depth", "1", run.repoUrl, REPO_DIR], {
      timeoutSeconds: 120,
    });
    db.appendEvent(runId, "command", {
      command: `git clone --depth 1 ${run.repoUrl}`,
      exitCode: clone.exitCode,
      seconds: clone.seconds,
      stderr: clone.stderr.slice(-500),
    });
    if (clone.exitCode !== 0) throw new Error(`Could not clone ${run.repoUrl}`);
    cloned = true;
    checkKill();

    db.appendEvent(runId, "agent_installed", { files: await installAgent(sandbox) });
    const reason = await runAgent(sandbox, run.task);
    await capturePatch();
    if (reason === "budget_exhausted") throw new BudgetStopped();
    if (reason !== "finished") throw new Error(`The agent stopped without finishing: ${reason}`);

    move("reviewing");
    db.appendEvent(runId, "review_skipped", { reason: "Supervisor not built yet (step 7)." });
    move("done");
  } catch (error) {
    if (error instanceof Killed) {
      // Decision 18: a killed run keeps whatever work exists so far.
      await capturePatch().catch(() => {});
      move("killed");
    } else if (error instanceof BudgetStopped) {
      move("budget_stopped");
    } else {
      move("failed", error instanceof Error ? error.message : String(error));
    }
  } finally {
    if (sandbox) {
      const report = await sandbox.destroy();
      db.saveSandboxUsage(runId, report.lifetimeSeconds, report.estimatedCostUsd);
      db.appendEvent(runId, "sandbox_destroyed", { ...report });
    }
  }
}
