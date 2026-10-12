/**
 * Application ↔ persistent state.
 *
 * SQLite through Node's built-in driver: a single file, no account and no
 * cost. Callers use only the functions below, so moving to hosted Postgres at
 * deploy time means rewriting this file and nothing else.
 */
import { DatabaseSync } from "node:sqlite";

import { assertTransition } from "../orchestrator/state.ts";
import type { RunStatus } from "../orchestrator/state.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  status TEXT NOT NULL,
  kill_requested INTEGER NOT NULL DEFAULT 0,
  patch TEXT,
  error TEXT,
  sandbox_seconds REAL,
  sandbox_cost_usd REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, id);
CREATE TABLE IF NOT EXISTS model_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL,
  tier TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reason TEXT NOT NULL
);
`;

export interface Run {
  id: string;
  task: string;
  repoUrl: string;
  status: RunStatus;
  killRequested: boolean;
  patch: string | null;
  error: string | null;
  sandboxSeconds: number | null;
  sandboxCostUsd: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunEvent {
  id: number;
  runId: string;
  at: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ModelAssignment {
  runId: string;
  at: string;
  tier: string;
  decidedBy: string;
  reason: string;
}

type Row = Record<string, any>;

const toRun = (row: Row): Run => ({
  id: row.id,
  task: row.task,
  repoUrl: row.repo_url,
  status: row.status,
  killRequested: row.kill_requested === 1,
  patch: row.patch,
  error: row.error,
  sandboxSeconds: row.sandbox_seconds,
  sandboxCostUsd: row.sandbox_cost_usd,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toEvent = (row: Row): RunEvent => ({
  id: row.id,
  runId: row.run_id,
  at: row.at,
  type: row.type,
  data: JSON.parse(row.data),
});

export class Db {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
    this.#now = now;
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  createRun(run: { id: string; task: string; repoUrl: string }): Run {
    const at = this.#stamp();
    this.#db
      .prepare("INSERT INTO runs (id, task, repo_url, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(run.id, run.task, run.repoUrl, at, at);
    return this.getRun(run.id)!;
  }

  getRun(id: string): Run | null {
    const row = this.#db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  listRuns(limit = 50): Run[] {
    return this.#db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit).map(toRun);
  }

  /** Move a run to a new status, refusing moves the lifecycle does not allow. */
  setStatus(id: string, to: RunStatus, error?: string): Run {
    const run = this.getRun(id);
    if (!run) throw new Error(`No run ${id}`);
    assertTransition(run.status, to);
    this.#db
      .prepare("UPDATE runs SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE id = ?")
      .run(to, error ?? null, this.#stamp(), id);
    return this.getRun(id)!;
  }

  requestKill(id: string): void {
    this.#db.prepare("UPDATE runs SET kill_requested = 1, updated_at = ? WHERE id = ?").run(this.#stamp(), id);
  }

  savePatch(id: string, patch: string): void {
    this.#db.prepare("UPDATE runs SET patch = ?, updated_at = ? WHERE id = ?").run(patch, this.#stamp(), id);
  }

  saveSandboxUsage(id: string, seconds: number, costUsd: number): void {
    this.#db
      .prepare("UPDATE runs SET sandbox_seconds = ?, sandbox_cost_usd = ?, updated_at = ? WHERE id = ?")
      .run(seconds, costUsd, this.#stamp(), id);
  }

  appendEvent(runId: string, type: string, data: Record<string, unknown> = {}): RunEvent {
    const at = this.#stamp();
    const result = this.#db
      .prepare("INSERT INTO events (run_id, at, type, data) VALUES (?, ?, ?, ?)")
      .run(runId, at, type, JSON.stringify(data));
    return { id: Number(result.lastInsertRowid), runId, at, type, data };
  }

  /** Events for a run in order; pass the last id seen to get only newer ones. */
  listEvents(runId: string, afterId = 0): RunEvent[] {
    return this.#db
      .prepare("SELECT * FROM events WHERE run_id = ? AND id > ? ORDER BY id")
      .all(runId, afterId)
      .map(toEvent);
  }

  addAssignment(runId: string, assignment: { tier: string; decidedBy: string; reason: string }): void {
    this.#db
      .prepare("INSERT INTO model_assignments (run_id, at, tier, decided_by, reason) VALUES (?, ?, ?, ?, ?)")
      .run(runId, this.#stamp(), assignment.tier, assignment.decidedBy, assignment.reason);
  }

  listAssignments(runId: string): ModelAssignment[] {
    return this.#db
      .prepare("SELECT * FROM model_assignments WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((row: Row) => ({
        runId: row.run_id,
        at: row.at,
        tier: row.tier,
        decidedBy: row.decided_by,
        reason: row.reason,
      }));
  }

  close(): void {
    this.#db.close();
  }
}
