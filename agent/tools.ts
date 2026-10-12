/** What the tools actually do, inside the sandbox, confined to the repository. */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ToolCall } from "./protocol.ts";

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Results are fed back to a model with a 4,096-token window, so keep them short. */
export const OUTPUT_LIMIT = 1500;
const SHELL_TIMEOUT_MS = 30_000;

export function clip(text: string, limit = OUTPUT_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[cut: ${text.length} characters in total]`;
}

/** The absolute path, or null if it would land outside the repository. */
export function insideRepo(repoDir: string, path: string): string | null {
  const root = resolve(repoDir);
  const target = resolve(root, path);
  return target === root || target.startsWith(root + sep) ? target : null;
}

function run(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(file, args, { cwd, timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      done({ code, stdout, stderr: error?.killed ? `${stderr}\n[stopped after ${SHELL_TIMEOUT_MS / 1000} s]` : stderr });
    });
  });
}

export async function runTool(call: ToolCall, repoDir: string): Promise<ToolResult> {
  const { tool, args } = call;
  try {
    if (tool === "read_file" || tool === "write_file") {
      const path = insideRepo(repoDir, args.path);
      if (!path) return { ok: false, output: `ERROR: ${args.path} is outside the repository` };
      if (tool === "read_file") return { ok: true, output: clip(await readFile(path, "utf8")) };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, args.content);
      return { ok: true, output: `Wrote ${args.content.length} characters to ${args.path}` };
    }
    if (tool === "search_files") {
      const found = await run("rg", ["--line-number", "--max-count", "5", "--max-columns", "200", "--", args.pattern, "."], repoDir);
      if (found.code === 1) return { ok: true, output: "No matches." };
      if (found.code !== 0) return { ok: false, output: clip(`ERROR: ${found.stderr.trim()}`) };
      return { ok: true, output: clip(found.stdout) };
    }
    if (tool === "run_shell") {
      const result = await run("sh", ["-c", args.command], repoDir);
      const text = [`exit code ${result.code}`, result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
      return { ok: result.code === 0, output: clip(text) };
    }
    return { ok: false, output: `ERROR: unknown tool ${tool}` };
  } catch (error) {
    return { ok: false, output: clip(`ERROR: ${error instanceof Error ? error.message : String(error)}`) };
  }
}
