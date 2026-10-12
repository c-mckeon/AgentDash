import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { createApi, validateNewRun } from "../api/server.ts";
import { loadConfig } from "../config.ts";
import { Db } from "../db/index.ts";
import { STATUSES, canTransition, isTerminal } from "../orchestrator/state.ts";
import { signRunToken, verifyRunToken } from "../orchestrator/tokens.ts";

// ---------------------------------------------------------------- lifecycle

test("the happy path is queued → triaging → running → reviewing → done", () => {
  const path = ["queued", "triaging", "running", "reviewing", "done"] as const;
  for (let i = 0; i < path.length - 1; i++) assert.ok(canTransition(path[i], path[i + 1]));
});

test("stages cannot be skipped or reversed", () => {
  assert.equal(canTransition("queued", "running"), false);
  assert.equal(canTransition("running", "triaging"), false);
  assert.equal(canTransition("queued", "done"), false);
});

test("any run in progress can fail, be killed or be stopped by the budget", () => {
  for (const from of ["queued", "triaging", "running", "reviewing"] as const) {
    for (const to of ["failed", "killed", "budget_stopped"] as const) assert.ok(canTransition(from, to));
  }
});

test("finished runs never move again", () => {
  for (const from of ["done", "failed", "killed", "budget_stopped"] as const) {
    assert.ok(isTerminal(from));
    for (const to of STATUSES) assert.equal(canTransition(from, to), false);
  }
});

// ---------------------------------------------------------------- run passes

const SECRET = "test-secret";
// Produced by gateway/core.py for the same inputs; the two must agree.
const KNOWN = "run_abc123.2000000000.fc0e121f129f9eb9deb4e8237b41a5be2f3f96bb3f95a7d498766944e04eb15a";

test("a pass matches the gateway's Python implementation", () => {
  assert.equal(signRunToken(SECRET, "run_abc123", 2000000000), KNOWN);
});

test("a genuine, unexpired pass yields its run id", () => {
  assert.equal(verifyRunToken(SECRET, KNOWN, 1999999999), "run_abc123");
});

test("expired, tampered, wrong-key and malformed passes are refused", () => {
  assert.equal(verifyRunToken(SECRET, KNOWN, 2000000000), null);
  assert.equal(verifyRunToken(SECRET, KNOWN.replace("run_abc123", "run_other1"), 1), null);
  assert.equal(verifyRunToken(SECRET, KNOWN.replace("2000000000", "3000000000"), 1), null);
  assert.equal(verifyRunToken("other-secret", KNOWN, 1), null);
  assert.equal(verifyRunToken(SECRET, "not-a-pass", 1), null);
  assert.equal(verifyRunToken(SECRET, "", 1), null);
});

// ---------------------------------------------------------------- config

test("config reports every missing variable at once", () => {
  assert.throws(() => loadConfig({}), /GATEWAY_URL, GATEWAY_KEY, OWNER_TOKEN/);
});

test("config applies defaults and trims the gateway address", () => {
  const config = loadConfig({ GATEWAY_URL: "https://g.example/", GATEWAY_KEY: "k", OWNER_TOKEN: "o" });
  assert.equal(config.gatewayUrl, "https://g.example");
  assert.equal(config.port, 8787);
  assert.equal(config.sandboxMaxLifetimeSeconds, 600);
});

// ---------------------------------------------------------------- database

test("a run is stored, moved through its lifecycle, and keeps its events in order", () => {
  const db = new Db(":memory:");
  const run = db.createRun({ id: "run_1", task: "fix it", repoUrl: "https://github.com/a/b" });
  assert.equal(run.status, "queued");
  assert.equal(run.killRequested, false);

  db.setStatus("run_1", "triaging");
  assert.throws(() => db.setStatus("run_1", "done"), /cannot go from triaging to done/);
  db.setStatus("run_1", "failed", "boom");
  assert.equal(db.getRun("run_1")!.error, "boom");

  const first = db.appendEvent("run_1", "status", { status: "queued" });
  db.appendEvent("run_1", "command", { exitCode: 0 });
  assert.deepEqual(db.listEvents("run_1").map((event) => event.type), ["status", "command"]);
  assert.deepEqual(db.listEvents("run_1", first.id).map((event) => event.type), ["command"]);
  assert.deepEqual(db.listEvents("run_1")[1].data, { exitCode: 0 });

  db.addAssignment("run_1", { tier: "small", decidedBy: "default", reason: "r" });
  assert.equal(db.listAssignments("run_1")[0].tier, "small");
  db.savePatch("run_1", "diff");
  db.saveSandboxUsage("run_1", 12.5, 0.0006);
  db.requestKill("run_1");
  const saved = db.getRun("run_1")!;
  assert.equal(saved.patch, "diff");
  assert.equal(saved.sandboxSeconds, 12.5);
  assert.equal(saved.killRequested, true);
  assert.equal(db.getRun("missing"), null);
  db.close();
});

// ---------------------------------------------------------------- API

test("new runs must name a task and a public GitHub repository", () => {
  assert.deepEqual(validateNewRun({ task: " fix ", repoUrl: "https://github.com/octocat/Hello-World" }), {
    task: "fix",
    repoUrl: "https://github.com/octocat/Hello-World",
  });
  for (const bad of [
    null,
    {},
    { task: "", repoUrl: "https://github.com/a/b" },
    { task: "x", repoUrl: "http://github.com/a/b" },
    { task: "x", repoUrl: "https://gitlab.com/a/b" },
    { task: "x", repoUrl: "https://github.com/a/b; rm -rf /" },
    { task: "x", repoUrl: "git@github.com:a/b.git" },
    { task: "x".repeat(4001), repoUrl: "https://github.com/a/b" },
  ]) {
    assert.equal(typeof validateNewRun(bad), "string");
  }
});

let db: Db;
let base: string;
let started: string[];
let server: ReturnType<typeof createApi>;
const OWNER = { authorization: "Bearer owner-secret", "content-type": "application/json" };
const NEW_RUN = JSON.stringify({ task: "fix it", repoUrl: "https://github.com/octocat/Hello-World" });

before(async () => {
  db = new Db(":memory:");
  started = [];
  server = createApi({ db, ownerToken: "owner-secret", startRun: (id) => started.push(id) });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  db.close();
});

test("starting a run needs the owner's token", async () => {
  const none = await fetch(`${base}/runs`, { method: "POST", body: NEW_RUN });
  const wrong = await fetch(`${base}/runs`, { method: "POST", body: NEW_RUN, headers: { authorization: "Bearer nope" } });
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(started.length, 0);
});

test("the owner can start a run, and anyone can read it", async () => {
  const created = await fetch(`${base}/runs`, { method: "POST", body: NEW_RUN, headers: OWNER });
  assert.equal(created.status, 201);
  const { run } = (await created.json()) as { run: { id: string; status: string } };
  assert.equal(run.status, "queued");
  assert.deepEqual(started, [run.id]);

  const read = (await (await fetch(`${base}/runs/${run.id}`)).json()) as { run: { task: string } };
  assert.equal(read.run.task, "fix it");
  const events = (await (await fetch(`${base}/runs/${run.id}/events`)).json()) as { events: { type: string }[] };
  assert.equal(events.events[0].type, "status");
  const list = (await (await fetch(`${base}/runs`)).json()) as { runs: unknown[] };
  assert.equal(list.runs.length, 1);
});

test("bad requests and unknown runs are refused clearly", async () => {
  const invalid = await fetch(`${base}/runs`, { method: "POST", body: "{}", headers: OWNER });
  const garbled = await fetch(`${base}/runs`, { method: "POST", body: "{", headers: OWNER });
  assert.equal(invalid.status, 400);
  assert.equal(garbled.status, 400);
  assert.equal((await fetch(`${base}/runs/run_missing`)).status, 404);
  assert.equal((await fetch(`${base}/nothing`)).status, 404);
});

test("killing needs the owner, flags the run, and is refused once the run has ended", async () => {
  const [id] = started;
  assert.equal((await fetch(`${base}/runs/${id}/kill`, { method: "POST" })).status, 401);
  assert.equal((await fetch(`${base}/runs/${id}/kill`, { method: "POST", headers: OWNER })).status, 202);
  assert.equal(db.getRun(id)!.killRequested, true);
  db.setStatus(id, "killed");
  assert.equal((await fetch(`${base}/runs/${id}/kill`, { method: "POST", headers: OWNER })).status, 409);
});
