// Tabs for the whole site, and the recorded-run preview on the Dashboard tab.
// The preview is read-only: it draws runs saved in data/runs.json and has no
// connection to the API, the gateway or Modal.

// ---------------------------------------------------------------- tabs

const TABS = ["dashboard", "architecture", "research"];

function showTab(wanted) {
  const tab = TABS.includes(wanted) ? wanted : "dashboard";
  for (const name of TABS) {
    document.getElementById(`tab-${name}`).hidden = name !== tab;
    const link = document.querySelector(`nav.tabs a[href="#${name}"]`);
    if (name === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  document.title = `AgentDash ${tab[0].toUpperCase()}${tab.slice(1)}`;
}

// Switching tabs never changes the address: any link to a tab is handled here
// instead of by the browser.
document.addEventListener("click", (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const name = link.getAttribute("href").slice(1);
  if (!TABS.includes(name)) return;
  event.preventDefault();
  showTab(name);
  window.scrollTo(0, 0);
});

// An old link such as architecture.html arrives with a tab name after the #.
// Open that tab, then tidy the address back to the plain one.
showTab(location.hash.slice(1));
if (location.hash) history.replaceState(null, "", location.pathname + location.search);

// ---------------------------------------------------------------- helpers

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

const usd = (value) => (value < 0.01 ? `${(value * 100).toFixed(2)}¢` : `$${value.toFixed(2)}`);
const secs = (value) => `${value.toFixed(1)} s`;
const sum = (items, pick) => items.reduce((total, item) => total + (pick(item) || 0), 0);

const STATUS = {
  done: { label: "Done", icon: "✓", tone: "good" },
  failed: { label: "Failed", icon: "✕", tone: "bad" },
  killed: { label: "Killed", icon: "■", tone: "bad" },
  budget_stopped: { label: "Budget stop", icon: "!", tone: "bad" },
};

function statusChip(status) {
  const info = STATUS[status] ?? { label: status, icon: "…", tone: "neutral" };
  return el("span", { class: `status ${info.tone}`, text: `${info.icon} ${info.label}` });
}

function modelUsage(entry) {
  const calls = entry.events.filter((event) => event.type === "agent_model").map((event) => event.data.usage ?? {});
  return {
    calls: calls.length,
    modelSeconds: sum(calls, (usage) => usage.model_seconds),
    idleSeconds: sum(calls, (usage) => usage.idle_seconds),
    promptTokens: sum(calls, (usage) => usage.prompt_tokens),
    outputTokens: sum(calls, (usage) => usage.output_tokens),
    modelCost: sum(calls, (usage) => usage.cost_usd),
  };
}

const runSeconds = (run) => (new Date(run.updatedAt) - new Date(run.createdAt)) / 1000;
const runCost = (entry) => modelUsage(entry).modelCost + (entry.run.sandboxCostUsd ?? 0);

// ---------------------------------------------------------------- event wording

function describe(event) {
  const data = event.data;
  const args = (object) => Object.entries(object ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
  switch (event.type) {
    case "status":
      return { who: "system", title: `Status: ${data.status.replace("_", " ")}`, detail: data.error };
    case "routing":
      return { who: "router", title: `Model chosen: ${data.tier}`, detail: `Decided by: ${data.decidedBy}. ${data.reason}` };
    case "sandbox_created":
      return { who: "system", title: `Sandbox created in ${secs(data.seconds)}` };
    case "command":
      return { who: "system", title: `Ran: ${data.command}`, detail: `exit code ${data.exitCode}, ${secs(data.seconds)}` };
    case "agent_installed":
      return { who: "system", title: `Agent copied into the sandbox (${data.files} files)` };
    case "agent_model": {
      const usage = data.usage ?? {};
      return {
        who: "model",
        title: `Step ${data.step}: model replied in ${secs(usage.model_seconds ?? 0)}`,
        detail: `${usage.prompt_tokens} tokens read, ${usage.output_tokens} written, ${usd(usage.cost_usd ?? 0)}`,
      };
    }
    case "agent_tool_call":
      return { who: "agent", title: `Step ${data.step}: ${data.tool}`, code: args(data.args) };
    case "agent_tool_result":
      return { who: "agent", title: data.ok ? "Result" : "Result (error)", code: data.output };
    case "agent_parse_error":
      return { who: "agent", title: "Reply could not be read", detail: data.error };
    case "agent_finished":
      return { who: "agent", title: `Agent stopped: ${String(data.reason).replace("_", " ")}`, detail: data.summary };
    case "patch_captured":
      return { who: "system", title: `Patch saved (${data.bytes} characters)` };
    case "review_skipped":
      return { who: "supervisor", title: "Review skipped", detail: data.reason };
    case "sandbox_destroyed":
      return {
        who: "system",
        title: `Sandbox destroyed after ${secs(data.lifetimeSeconds)}`,
        detail: `estimated ${usd(data.estimatedCostUsd)}`,
      };
    case "kill_requested":
      return { who: "owner", title: "Kill requested" };
    default:
      return { who: "system", title: event.type, detail: JSON.stringify(data) };
  }
}

// ---------------------------------------------------------------- rendering

let replayTimer = null;

function renderTiles(root, recorded) {
  const entries = recorded.runs;
  const done = entries.filter((entry) => entry.run.status === "done").length;
  const tile = (label, value, note) =>
    el("div", { class: "tile" }, el("div", { class: "tile-label", text: label }), el("div", { class: "tile-value", text: value }), el("div", { class: "tile-note", text: note }));

  const budget = recorded.budget;
  const used = Math.min(budget.spent_usd / budget.limit_usd, 1);
  const meter = el("div", { class: "meter", role: "img", "aria-label": `${Math.round(used * 100)}% of the monthly limit used` }, el("div", { class: "meter-fill", style: `width:${(used * 100).toFixed(1)}%` }));
  const budgetTile = tile("Month's spend", `$${budget.spent_usd.toFixed(2)}`, `of a $${budget.limit_usd.toFixed(2)} hard stop, from Modal's meter`);
  budgetTile.append(meter);

  root.append(
    tile("Recorded runs", String(entries.length), `${done} reported done by the agent`),
    tile("Model time", secs(sum(entries, (entry) => modelUsage(entry).modelSeconds)), `${sum(entries, (entry) => modelUsage(entry).calls)} model calls on CPU`),
    tile("Cost of these runs", usd(sum(entries, runCost)), "model time plus sandbox time"),
    budgetTile,
  );
}

function renderRun(root, entry) {
  clearTimeout(replayTimer);
  root.replaceChildren();
  const { run, assignments, events } = entry;
  const usage = modelUsage(entry);
  const started = new Date(run.createdAt);

  const replay = el("button", { type: "button", class: "button", text: "▶ Replay" });
  root.append(
    el("div", { class: "run-head" }, statusChip(run.status), el("h3", { text: run.task })),
    el("p", { class: "note", text: `${run.id} · ${run.repoUrl} · ${secs(runSeconds(run))} · model tier "${assignments[0]?.tier ?? "?"}" (${assignments[0]?.decidedBy ?? "?"})` }),
    el(
      "div",
      { class: "controls" },
      replay,
      el("button", { type: "button", class: "button", disabled: "", title: "Not connected on this public preview", text: "Start a run" }),
      el("button", { type: "button", class: "button", disabled: "", title: "Not connected on this public preview", text: "Kill run" }),
    ),
  );

  // Cost
  const cost = el("table", { class: "cost" });
  const row = (label, value) => cost.append(el("tr", {}, el("td", { text: label }), el("td", { class: "num", text: value })));
  row("Model calls", String(usage.calls));
  row("Model working time", secs(usage.modelSeconds));
  row("Idle machine time charged to this run", secs(usage.idleSeconds));
  row("Tokens read / written", `${usage.promptTokens} / ${usage.outputTokens}`);
  row("Model cost (ledger)", usd(usage.modelCost));
  row("Sandbox lifetime", secs(run.sandboxSeconds ?? 0));
  row("Sandbox cost (estimate)", usd(run.sandboxCostUsd ?? 0));
  row("Total", usd(runCost(entry)));

  // Timeline
  const feed = el("ol", { class: "feed" });
  const items = events.map((event) => {
    const info = describe(event);
    const item = el(
      "li",
      { class: `feed-item who-${info.who}` },
      el("span", { class: "feed-time", text: `+${((new Date(event.at) - started) / 1000).toFixed(1)}s` }),
      el("span", { class: "feed-who", text: info.who }),
      el("div", { class: "feed-body" }, el("div", { class: "feed-title", text: info.title })),
    );
    if (info.detail) item.lastChild.append(el("div", { class: "note", text: info.detail }));
    if (info.code) item.lastChild.append(el("pre", { text: info.code }));
    feed.append(item);
    return { item, at: new Date(event.at) };
  });

  // Patch
  const patch = el("pre", { class: "diff" });
  for (const line of (run.patch || "(no changes)").split("\n")) {
    const kind = line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : "";
    patch.append(el("span", { class: kind, text: `${line}\n` }));
  }

  root.append(
    el("h3", { text: "What happened" }),
    feed,
    el("h3", { text: "Resulting patch" }),
    patch,
    el("h3", { text: "Cost and compute" }),
    el("div", { class: "scroll" }, cost),
  );

  replay.addEventListener("click", () => {
    clearTimeout(replayTimer);
    for (const { item } of items) item.hidden = true;
    let index = 0;
    const next = () => {
      if (index >= items.length) return;
      items[index].item.hidden = false;
      const gap = index + 1 < items.length ? items[index + 1].at - items[index].at : 0;
      index++;
      // Real gaps, sped up and capped so a long model call does not stall the replay.
      replayTimer = setTimeout(next, Math.min(Math.max(gap / 4, 120), 900));
    };
    next();
  });
}

function renderDashboard(recorded) {
  const tiles = document.getElementById("dash-tiles");
  const list = document.getElementById("dash-runs");
  const detail = document.getElementById("dash-detail");
  document.getElementById("dash-recorded").textContent = new Date(recorded.exportedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  renderTiles(tiles, recorded);

  const buttons = recorded.runs.map((entry) => {
    const button = el(
      "button",
      { type: "button", class: "run-row" },
      statusChip(entry.run.status),
      el("span", { class: "run-task", text: entry.run.task }),
      el("span", { class: "run-meta", text: `${secs(runSeconds(entry.run))} · ${usd(runCost(entry))}` }),
    );
    button.addEventListener("click", () => {
      for (const other of buttons) other.removeAttribute("aria-current");
      button.setAttribute("aria-current", "true");
      renderRun(detail, entry);
    });
    list.append(el("li", {}, button));
    return button;
  });
  buttons[0]?.click();
}

fetch("data/runs.json")
  .then((response) => response.json())
  .then(renderDashboard)
  .catch(() => {
    document.getElementById("dash-detail").append(
      el("p", { class: "note", text: "The recorded runs could not be loaded. Open the published site rather than the file on disk." }),
    );
  });
