/**
 * Entry point inside the sandbox. Reads its orders from the environment,
 * talks to the model through the gateway with the run's pass, and reports
 * every event as one JSON line on standard output for the orchestrator.
 */
import { MAX_REPLY_TOKENS } from "./context.ts";
import { runAgent } from "./loop.ts";
import type { ChatResult } from "./loop.ts";
import { REPLY_SCHEMA } from "./protocol.ts";
import { runTool } from "./tools.ts";

const { GATEWAY_URL, RUN_PASS, TASK, REPO_DIR, MAX_STEPS } = process.env;
if (!GATEWAY_URL || !RUN_PASS || !TASK || !REPO_DIR) {
  console.log(JSON.stringify({ type: "finished", step: 0, reason: "model_error", summary: "agent started without its settings" }));
  process.exit(2);
}

async function chat(messages: unknown[]): Promise<ChatResult> {
  try {
    const response = await fetch(`${GATEWAY_URL}/v1/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${RUN_PASS}`, "content-type": "application/json" },
      body: JSON.stringify({ messages, response_format: REPLY_SCHEMA, max_tokens: MAX_REPLY_TOKENS, temperature: 0 }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = (await response.json()) as Record<string, any>;
    if (!response.ok) return { ok: false, status: response.status, error: String(body.error ?? response.status) };
    return { ok: true, content: body.message?.content ?? "", usage: body.usage ?? {} };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

await runAgent(TASK, {
  chat,
  runTool: (call) => runTool(call, REPO_DIR),
  emit: (event) => console.log(JSON.stringify(event)),
  maxSteps: Number(MAX_STEPS ?? 8),
});
