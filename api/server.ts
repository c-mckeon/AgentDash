/**
 * Outside HTTP world ↔ the system.
 *
 * Reading is open to anyone (decision 16); starting and killing runs needs
 * the owner's token. Plain node:http, no framework.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import type { Db } from "../db/index.ts";
import { isTerminal } from "../orchestrator/state.ts";

/** Only public GitHub repositories over HTTPS, so a sandbox never needs credentials. */
const REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?$/;
const MAX_TASK_LENGTH = 4000;
const MAX_BODY_BYTES = 64 * 1024;

export interface ApiDeps {
  db: Db;
  ownerToken: string;
  /** Hands a newly created run to the orchestrator. Must not block. */
  startRun: (runId: string) => void;
}

export function validateNewRun(body: unknown): { task: string; repoUrl: string } | string {
  if (typeof body !== "object" || body === null) return "body must be a JSON object";
  const { task, repoUrl } = body as Record<string, unknown>;
  if (typeof task !== "string" || !task.trim()) return "task must be a non-empty string";
  if (task.length > MAX_TASK_LENGTH) return `task must be at most ${MAX_TASK_LENGTH} characters`;
  if (typeof repoUrl !== "string" || !REPO_URL.test(repoUrl)) {
    return "repoUrl must be a public GitHub repository, like https://github.com/owner/name";
  }
  return { task: task.trim(), repoUrl };
}

function isOwner(request: IncomingMessage, ownerToken: string): boolean {
  const given = Buffer.from((request.headers.authorization ?? "").replace(/^Bearer /, ""));
  const expected = Buffer.from(ownerToken);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createApi(deps: ApiDeps): Server {
  const { db, ownerToken, startRun } = deps;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const [, root, runId, action] = url.pathname.split("/");
      const method = request.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
      if (root !== "runs") return send(response, 404, { error: "not found" });

      if (!runId) {
        if (method === "GET") return send(response, 200, { runs: db.listRuns() });
        if (method === "POST") {
          if (!isOwner(request, ownerToken)) return send(response, 401, { error: "unauthorised" });
          let body: unknown;
          try {
            body = await readJson(request);
          } catch {
            return send(response, 400, { error: "body is not valid JSON" });
          }
          const valid = validateNewRun(body);
          if (typeof valid === "string") return send(response, 400, { error: valid });
          const run = db.createRun({ id: `run_${randomBytes(6).toString("hex")}`, ...valid });
          db.appendEvent(run.id, "status", { status: "queued" });
          startRun(run.id);
          return send(response, 201, { run });
        }
        return send(response, 405, { error: "method not allowed" });
      }

      const run = db.getRun(runId);
      if (!run) return send(response, 404, { error: "no such run" });

      if (method === "GET" && !action) {
        return send(response, 200, { run, assignments: db.listAssignments(runId) });
      }
      if (method === "GET" && action === "events") {
        const after = Number(url.searchParams.get("after") ?? 0) || 0;
        return send(response, 200, { events: db.listEvents(runId, after) });
      }
      if (method === "POST" && action === "kill") {
        if (!isOwner(request, ownerToken)) return send(response, 401, { error: "unauthorised" });
        if (isTerminal(run.status)) return send(response, 409, { error: `run already ${run.status}` });
        db.requestKill(runId);
        db.appendEvent(runId, "kill_requested", {});
        return send(response, 202, { ok: true });
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : "internal error" });
    }
  });
}
