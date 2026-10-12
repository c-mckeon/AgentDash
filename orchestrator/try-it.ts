/**
 * Live check of the skeleton: start the API, start one real run through it,
 * watch it finish, and check the gateway's handling of run passes.
 * Uses one sandbox for a few seconds and never wakes the model.
 *
 *   node orchestrator/try-it.ts
 */
import type { AddressInfo } from "node:net";

import { createApi } from "../api/server.ts";
import { loadConfig } from "../config.ts";
import { Db } from "../db/index.ts";
import { ModalSandboxProvider } from "../sandbox-provider/modal.ts";
import { executeRun } from "./run.ts";
import { isTerminal } from "./state.ts";
import { signRunToken } from "./tokens.ts";

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

async function runToEnd(body: object, killAfterMs?: number) {
  const created = await fetch(`${base}/runs`, { method: "POST", headers: owner, body: JSON.stringify(body) });
  const { run } = (await created.json()) as { run: { id: string } };
  if (killAfterMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, killAfterMs));
    await fetch(`${base}/runs/${run.id}/kill`, { method: "POST", headers: owner });
  }
  for (;;) {
    const state = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { run: any };
    // The sandbox report is written just after the final status, so wait for it.
    if (isTerminal(state.run.status) && (state.run.sandboxSeconds !== null || state.run.status === "killed")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const final = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { run: any };
      const { events } = (await (await fetch(`${base}/runs/${run.id}/events`)).json()) as { events: any[] };
      return {
        status: final.run.status,
        error: final.run.error,
        patchBytes: final.run.patch?.length ?? null,
        sandboxSeconds: final.run.sandboxSeconds,
        sandboxCostUsd: final.run.sandboxCostUsd,
        events: events.map((event) => `${event.type} ${JSON.stringify(event.data)}`.slice(0, 160)),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function gatewayStatus(token: string): Promise<number> {
  const response = await fetch(`${config.gatewayUrl}/v1/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}", // invalid on purpose: a valid pass gets 400 and the model is never called
  });
  return response.status;
}

const now = Math.floor(Date.now() / 1000);
const good = signRunToken(config.gatewayKey, "run_check", now + 60);
const report = {
  normalRun: await runToEnd({ task: "No agent yet", repoUrl: "https://github.com/octocat/Hello-World" }),
  missingRepo: await runToEnd({ task: "x", repoUrl: "https://github.com/octocat/this-repo-does-not-exist-9f3a" }),
  killedRun: await runToEnd({ task: "x", repoUrl: "https://github.com/octocat/Hello-World" }, 300),
  gatewayPasses: {
    valid: await gatewayStatus(good),
    expired: await gatewayStatus(signRunToken(config.gatewayKey, "run_check", now - 1)),
    tampered: await gatewayStatus(good.replace("run_check", "run_other")),
    wrongKey: await gatewayStatus(signRunToken("not-the-key", "run_check", now + 60)),
  },
};

console.log(JSON.stringify(report, null, 2));
api.close();
db.close();
sandboxes.close();
