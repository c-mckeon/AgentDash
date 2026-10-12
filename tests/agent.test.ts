import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { OMITTED_NOTE, estimateTokens, fitMessages } from "../agent/context.ts";
import type { Message } from "../agent/context.ts";
import { runAgent } from "../agent/loop.ts";
import type { AgentEvent, ChatResult } from "../agent/loop.ts";
import { parseReply, systemPrompt } from "../agent/protocol.ts";
import { clip, insideRepo, runTool } from "../agent/tools.ts";

// ---------------------------------------------------------------- reading replies
// The awkward shapes below are ones the model actually produced in research.

const READ = { call: { tool: "read_file", args: { path: "README.md" } } };

test("a clean reply is read as is", () => {
  assert.deepEqual(parseReply('{"tool": "read_file", "args": {"path": "README.md"}}'), READ);
});

test("a reply wrapped in a code block or prose is still read", () => {
  assert.deepEqual(parseReply('```json\n{\n  "tool": "read_file",\n  "args": {"path": "README.md"}\n}\n```'), READ);
  assert.deepEqual(parseReply('Sure! Here it is: {"tool": "read_file", "args": {"path": "README.md"}} Hope that helps.'), READ);
});

test("name/arguments spelling is accepted", () => {
  assert.deepEqual(parseReply('{"name": "read_file", "arguments": {"path": "README.md"}}'), READ);
});

test("an argument that echoes the schema is unwrapped", () => {
  const echoed = '{"tool": "read_file", "args": {"path": {"type": "string", "description": "Path", "value": "README.md"}}}';
  assert.deepEqual(parseReply(echoed), READ);
});

test("arguments left at the top level are found", () => {
  assert.deepEqual(parseReply('{"tool": "finish", "summary": "Done."}'), {
    call: { tool: "finish", args: { summary: "Done." } },
  });
});

test("braces inside strings do not confuse the reader", () => {
  const reply = 'ok {"tool": "write_file", "args": {"path": "a.js", "content": "function f() { return \\"}\\"; }"}}';
  assert.deepEqual(parseReply(reply), {
    call: { tool: "write_file", args: { path: "a.js", content: 'function f() { return "}"; }' } },
  });
});

test("invented tools, missing arguments and non-JSON are reported, not guessed", () => {
  assert.match((parseReply('{"tool": "export", "args": {}}') as { error: string }).error, /unknown tool "export"/);
  assert.match((parseReply('{"tool": "read_file", "args": {}}') as { error: string }).error, /needs the argument "path"/);
  assert.match((parseReply("I think we should read the file.") as { error: string }).error, /no JSON object/);
});

test("the instructions name every tool and stay small", () => {
  const prompt = systemPrompt();
  for (const tool of ["read_file", "write_file", "search_files", "run_shell", "finish"]) assert.ok(prompt.includes(tool));
  assert.ok(estimateTokens(prompt) < 350);
});

// ---------------------------------------------------------------- context window

const step = (n: number, size: number): Message[] => [
  { role: "assistant", content: `call ${n}` },
  { role: "user", content: `result ${n} ${"x".repeat(size)}` },
];
const HEAD: Message[] = [
  { role: "system", content: "instructions" },
  { role: "user", content: "Task: do it" },
];

test("a conversation that fits is sent unchanged", () => {
  const messages = [...HEAD, ...step(1, 100)];
  assert.deepEqual(fitMessages(messages, 1000), messages);
});

test("oldest steps are dropped first; instructions and task always survive", () => {
  const messages = [...HEAD, ...step(1, 900), ...step(2, 900), ...step(3, 900)];
  const fitted = fitMessages(messages, 500);
  assert.deepEqual(fitted.slice(0, 2), HEAD);
  assert.equal(fitted[2].content, OMITTED_NOTE);
  assert.ok(fitted.at(-1)!.content.startsWith("result 3"));
  assert.ok(!fitted.some((message) => message.content.startsWith("result 1")));
});

test("a single oversized step is cut rather than losing the task", () => {
  const fitted = fitMessages([...HEAD, ...step(1, 30000)], 500);
  assert.deepEqual(fitted.slice(0, 2), HEAD);
  assert.ok(fitted.at(-1)!.content.endsWith("[cut to fit]"));
  assert.ok(fitted.reduce((sum, message) => sum + estimateTokens(message.content), 0) <= 500);
});

// ---------------------------------------------------------------- tools

test("paths are confined to the repository", () => {
  assert.ok(insideRepo("/workspace/repo", "src/a.ts"));
  assert.ok(insideRepo("/workspace/repo", "."));
  assert.equal(insideRepo("/workspace/repo", "../secrets"), null);
  assert.equal(insideRepo("/workspace/repo", "/etc/passwd"), null);
  assert.equal(insideRepo("/workspace/repo", "src/../../repo-other/x"), null);
});

test("long output is cut and says how long it was", () => {
  assert.equal(clip("short"), "short");
  assert.match(clip("y".repeat(5000)), /\[cut: 5000 characters in total\]$/);
});

test("write then read a file, creating folders, and refuse to escape", async () => {
  const repo = await mkdtemp(join(tmpdir(), "agentdash-"));
  try {
    const wrote = await runTool({ tool: "write_file", args: { path: "docs/note.md", content: "hello" } }, repo);
    assert.deepEqual(wrote, { ok: true, output: "Wrote 5 characters to docs/note.md" });
    assert.equal(await readFile(join(repo, "docs", "note.md"), "utf8"), "hello");
    assert.deepEqual(await runTool({ tool: "read_file", args: { path: "docs/note.md" } }, repo), { ok: true, output: "hello" });
    const missing = await runTool({ tool: "read_file", args: { path: "nope.md" } }, repo);
    assert.equal(missing.ok, false);
    assert.match(missing.output, /^ERROR:/);
    const escape = await runTool({ tool: "write_file", args: { path: "../outside.txt", content: "x" } }, repo);
    assert.match(escape.output, /outside the repository/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the loop
// Scripted replies stand in for the model here only to exercise the loop's rules.

function scripted(replies: (string | ChatResult)[]) {
  const events: AgentEvent[] = [];
  const calls: string[] = [];
  const seen: Message[][] = [];
  let index = 0;
  return {
    events,
    calls,
    seen,
    deps: {
      maxSteps: 5,
      emit: (event: AgentEvent) => void events.push(event),
      chat: async (messages: Message[]): Promise<ChatResult> => {
        seen.push(messages.map((message) => ({ ...message })));
        const reply = replies[Math.min(index++, replies.length - 1)];
        return typeof reply === "string" ? { ok: true, content: reply, usage: {} } : reply;
      },
      runTool: async (call: { tool: string }) => {
        calls.push(call.tool);
        return { ok: true, output: `ran ${call.tool}` };
      },
    },
  };
}

const call = (tool: string, args: object) => JSON.stringify({ tool, args });

test("the loop runs tools, feeds results back, and stops on finish", async () => {
  const script = scripted([call("read_file", { path: "a" }), call("finish", { summary: "all done" })]);
  const outcome = await runAgent("fix it", script.deps);
  assert.deepEqual(outcome, { reason: "finished", steps: 2, summary: "all done" });
  assert.deepEqual(script.calls, ["read_file"]);
  assert.equal(script.seen[1].at(-1)!.content, "Tool result:\nran read_file");
  assert.deepEqual(script.events.map((event) => event.type), ["model", "tool_call", "tool_result", "model", "tool_call", "finished"]);
});

test("an unreadable reply is explained to the model, which can recover", async () => {
  const script = scripted(["hmm, let me think", call("finish", { summary: "ok" })]);
  const outcome = await runAgent("fix it", script.deps);
  assert.equal(outcome.reason, "finished");
  assert.match(script.seen[1].at(-1)!.content, /not a valid tool call/);
});

test("three unreadable replies in a row end the run", async () => {
  const outcome = await runAgent("fix it", scripted(["no json here"]).deps);
  assert.deepEqual(outcome, { reason: "parse_errors", steps: 3, summary: undefined });
});

test("the same call three times in a row is treated as stuck", async () => {
  const script = scripted([call("read_file", { path: "a" })]);
  const outcome = await runAgent("fix it", script.deps);
  assert.equal(outcome.reason, "stuck");
  assert.equal(script.calls.length, 2);
});

test("the step limit ends a run that never finishes", async () => {
  const replies = [1, 2, 3, 4, 5, 6].map((n) => call("read_file", { path: `file${n}` }));
  assert.deepEqual(await runAgent("fix it", scripted(replies).deps), { reason: "max_steps", steps: 5, summary: undefined });
});

test("a spent budget or a failing model stops the run with the right reason", async () => {
  const spent = await runAgent("x", scripted([{ ok: false, status: 402, error: "budget_exhausted" }]).deps);
  const broken = await runAgent("x", scripted([{ ok: false, status: 502, error: "model service failed" }]).deps);
  assert.equal(spent.reason, "budget_exhausted");
  assert.equal(broken.reason, "model_error");
});
