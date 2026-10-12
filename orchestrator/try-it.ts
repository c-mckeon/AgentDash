/**
 * Live check: start the API, send real runs through it, and print what
 * happened. Each run uses a sandbox and wakes the model, so the whole check
 * costs a cent or two.
 *
 *   node orchestrator/try-it.ts              the default tasks below
 *   node orchestrator/try-it.ts "<task>"     one task of your own
 */
import { writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { createApi } from "../api/server.ts";
import { loadConfig } from "../config.ts";
import { Db } from "../db/index.ts";
import { ModalSandboxProvider } from "../sandbox-provider/modal.ts";
import { executeRun } from "./run.ts";
import { isTerminal } from "./state.ts";

const REPO = "https://github.com/octocat/Hello-World";
const DEFAULT_TASKS = [
  "Create a file named HELLO.md containing exactly this text: Hello from AgentDash.",
  "Add this line to the end of the file named README: Edited by an agent.",
  "Create a file named count.sh that prints the numbers 1 to 3, one per line, then run it with sh to check it works.",
];

process.loadEnvFile(".env");
const config = loadConfig();
const db = new Db(":memory:");
const sandboxes = new ModalSandboxProvider();
const api = createApi({
  db,
  ownerToken: config.ownerToken,
  startRun: (runId) => void executeRun({ db, sandboxes, config }, runId),
});
await new Promise<void>((resolve) => api.listen(0, resolve));
const base = `http://localhost:${(api.address() as AddressInfo).port}`;
const owner = { authorization: `Bearer ${config.ownerToken}`, "content-type": "application/json" };

async function runToEnd(task: string, killAfterMs?: number) {
  const started = Date.now();
  const created = await fetch(`${base}/runs`, { method: "POST", headers: owner, body: JSON.stringify({ task, repoUrl: REPO }) });
  const { run } = (await created.json()) as { run: { id: string } };
  if (killAfterMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, killAfterMs));
    await fetch(`${base}/runs/${run.id}/kill`, { method: "POST", headers: owner });
  }
  for (;;) {
    const state = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { run: any };
    if (isTerminal(state.run.status) && state.run.sandboxSeconds !== null) {
      const { events } = (await (await fetch(`${base}/runs/${run.id}/events`)).json()) as { events: any[] };
      const model = events.filter((event) => event.type === "agent_model").map((event) => event.data.usage ?? {});
      const sum = (key: string) => Number(model.reduce((total, usage) => total + (usage[key] ?? 0), 0).toFixed(4));
      return {
        task,
        status: state.run.status,
        error: state.run.error,
        wallSeconds: (Date.now() - started) / 1000,
        sandboxSeconds: state.run.sandboxSeconds,
        sandboxCostUsd: state.run.sandboxCostUsd,
        modelCalls: model.length,
        modelSeconds: sum("model_seconds"),
        promptTokens: sum("prompt_tokens"),
        outputTokens: sum("output_tokens"),
        modelCostUsd: sum("cost_usd"),
        parseErrors: events.filter((event) => event.type === "agent_parse_error").length,
        steps: events
          .filter((event) => ["agent_tool_call", "agent_tool_result", "agent_parse_error", "agent_finished", "agent_output"].includes(event.type))
          .map((event) => `${event.type.replace("agent_", "")} ${JSON.stringify(event.data)}`.slice(0, 260)),
        patch: state.run.patch,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// --export <file> saves the complete runs (record, model choices, every event)
// for the dashboard's recorded-run preview, and skips the kill check.
const exportAt = process.argv.indexOf("--export");
const exportPath = exportAt === -1 ? null : process.argv[exportAt + 1];
const custom = exportAt === 2 ? undefined : process.argv[2];
const results = [];
for (const task of custom ? [custom] : DEFAULT_TASKS) results.push(await runToEnd(task));
if (!custom && !exportPath) results.push({ killed: await runToEnd(DEFAULT_TASKS[2], 6000) });

if (exportPath) {
  const usage = await fetch(`${config.gatewayUrl}/v1/usage`, { headers: { authorization: `Bearer ${config.gatewayKey}` } });
  const { budget } = (await usage.json()) as { budget: unknown };
  const runs = db
    .listRuns()
    .reverse()
    .map((run) => ({ run, assignments: db.listAssignments(run.id), events: db.listEvents(run.id) }));
  await writeFile(exportPath, JSON.stringify({ exportedAt: new Date().toISOString(), budget, runs }, null, 1));
}

console.log(JSON.stringify(results.map(({ patch, ...rest }: any) => rest), null, 2));
api.close();
db.close();
sandboxes.close();
