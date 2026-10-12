/**
 * Coordinates one run from start to finish.
 *
 * At this step there is no agent, router or supervisor yet, so those stages
 * are passed through and say so in the event log. What is real: the lifecycle,
 * the sandbox, the clone, the patch capture, the kill switch, the per-run
 * gateway pass, and the record of what the sandbox cost.
 */
import type { Config } from "../config.ts";
import type { Db } from "../db/index.ts";
import type { Sandbox, SandboxProvider } from "../sandbox-provider/types.ts";
import type { RunStatus } from "./state.ts";
import { signRunToken } from "./tokens.ts";

const REPO_DIR = "/workspace/repo";

export interface RunDeps {
  db: Db;
  sandboxes: SandboxProvider;
  config: Config;
}

/** Thrown between stages when the owner has asked for the run to stop. */
class Killed extends Error {}

export async function executeRun(deps: RunDeps, runId: string): Promise<void> {
  const { db, sandboxes, config } = deps;
  let sandbox: Sandbox | null = null;
  let cloned = false;

  const move = (to: RunStatus, error?: string) => {
    db.setStatus(runId, to, error);
    db.appendEvent(runId, "status", { status: to, ...(error ? { error } : {}) });
  };
  const checkKill = () => {
    if (db.getRun(runId)?.killRequested) throw new Killed();
  };
  const capturePatch = async () => {
    if (!sandbox || !cloned) return;
    // --intent-to-add makes brand-new files show up in the diff as well.
    await sandbox.exec(["git", "add", "--intent-to-add", "."], { workdir: REPO_DIR });
    const diff = await sandbox.exec(["git", "diff"], { workdir: REPO_DIR });
    db.savePatch(runId, diff.stdout);
    db.appendEvent(runId, "patch_captured", { bytes: diff.stdout.length });
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

    // The pass the agent will use to reach the model. Until the agent exists,
    // prove the path with an empty request from inside the sandbox: the gateway
    // accepts the pass and rejects the body (400) without waking the model.
    // Only the expiry is logged, never the pass itself.
    const expiresAt = Math.floor(Date.now() / 1000) + config.runTokenTtlSeconds;
    const pass = signRunToken(config.gatewayKey, runId, expiresAt);
    const probe = await sandbox.exec([
      "curl", "-s", "-m", "20", "-o", "/dev/null", "-w", "%{http_code}",
      "-X", "POST", "-H", `Authorization: Bearer ${pass}`, "-H", "Content-Type: application/json",
      "-d", "{}", `${config.gatewayUrl}/v1/chat`,
    ]);
    db.appendEvent(runId, "gateway_pass_checked", {
      expiresAt,
      httpStatus: Number(probe.stdout.trim()) || null,
      accepted: probe.stdout.trim() === "400",
    });
    db.appendEvent(runId, "agent_skipped", { reason: "Harness not built yet (step 4)." });
    checkKill();

    await capturePatch();
    move("reviewing");
    db.appendEvent(runId, "review_skipped", { reason: "Supervisor not built yet (step 7)." });
    move("done");
  } catch (error) {
    if (error instanceof Killed) {
      // Decision 18: a killed run keeps whatever work exists so far.
      await capturePatch().catch(() => {});
      move("killed");
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
