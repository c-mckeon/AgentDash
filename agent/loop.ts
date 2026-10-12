/**
 * The agent loop: ask the model for a tool call, carry it out, show the model
 * the result, repeat. Everything it touches is passed in, so the loop itself
 * knows nothing about HTTP, files or sandboxes.
 */
import { fitMessages } from "./context.ts";
import type { Message } from "./context.ts";
import { parseReply, systemPrompt } from "./protocol.ts";
import type { ToolCall } from "./protocol.ts";
import { clip } from "./tools.ts";
import type { ToolResult } from "./tools.ts";

export type ChatResult =
  | { ok: true; content: string; usage: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export type StopReason = "finished" | "max_steps" | "stuck" | "parse_errors" | "budget_exhausted" | "model_error";

export interface AgentEvent {
  type: "model" | "tool_call" | "tool_result" | "parse_error" | "finished";
  step: number;
  [key: string]: unknown;
}

export interface LoopDeps {
  chat(messages: Message[]): Promise<ChatResult>;
  runTool(call: ToolCall): Promise<ToolResult>;
  emit(event: AgentEvent): void;
  maxSteps: number;
}

export interface Outcome {
  reason: StopReason;
  steps: number;
  summary?: string;
}

/** Stop if the model makes the identical call this many times in a row. */
const REPEAT_LIMIT = 3;
/** Stop if this many replies in a row cannot be read as a tool call. */
const PARSE_ERROR_LIMIT = 3;

export async function runAgent(task: string, deps: LoopDeps): Promise<Outcome> {
  const messages: Message[] = [
    { role: "system", content: systemPrompt() },
    { role: "user", content: `Task: ${task}` },
  ];
  let lastCall = "";
  let repeats = 0;
  let parseErrors = 0;

  const stop = (step: number, reason: StopReason, summary?: string): Outcome => {
    deps.emit({ type: "finished", step, reason, ...(summary ? { summary } : {}) });
    return { reason, steps: step, summary };
  };

  for (let step = 1; step <= deps.maxSteps; step++) {
    const reply = await deps.chat(fitMessages(messages));
    if (!reply.ok) {
      return stop(step, reply.status === 402 ? "budget_exhausted" : "model_error", reply.error);
    }
    deps.emit({ type: "model", step, content: clip(reply.content, 600), usage: reply.usage });
    messages.push({ role: "assistant", content: reply.content });

    const parsed = parseReply(reply.content);
    if ("error" in parsed) {
      deps.emit({ type: "parse_error", step, error: parsed.error });
      if (++parseErrors >= PARSE_ERROR_LIMIT) return stop(step, "parse_errors");
      messages.push({
        role: "user",
        content: `That was not a valid tool call: ${parsed.error}. Reply with one JSON object like {"tool": "read_file", "args": {"path": "README.md"}}`,
      });
      continue;
    }
    parseErrors = 0;

    const { call } = parsed;
    deps.emit({ type: "tool_call", step, tool: call.tool, args: call.args });
    if (call.tool === "finish") return stop(step, "finished", call.args.summary);

    const signature = JSON.stringify(call);
    repeats = signature === lastCall ? repeats + 1 : 1;
    lastCall = signature;
    if (repeats >= REPEAT_LIMIT) return stop(step, "stuck", `repeated ${call.tool} ${REPEAT_LIMIT} times`);

    const result = await deps.runTool(call);
    deps.emit({ type: "tool_result", step, ok: result.ok, output: clip(result.output, 600) });
    messages.push({ role: "user", content: `Tool result:\n${result.output}` });
  }
  return stop(deps.maxSteps, "max_steps");
}
