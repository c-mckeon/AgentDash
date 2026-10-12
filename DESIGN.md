# AgentDash — Design Notes

Working record of decisions from the design grilling session. Started 2026-10-12.

## Starting architecture (initial guess)

| Module | Boundary |
| --- | --- |
| `config.ts` | environment ↔ application |
| `api/` | outside HTTP world ↔ factory |
| `orchestrator/` | coordinates a run |
| `db/` | application ↔ persistent state |
| `sandbox-provider/` | factory ↔ disposable computers |
| `sandbox/` | defines what runs on those computers |
| `agent/` | decides/executes the coding work |
| `tests/` | proves those boundaries actually work |

## Decisions

### 1. Purpose: portfolio project
The goal is to demonstrate four capabilities, and these are what the design should optimise for:
1. **Harnessing** agents to do real work in sandboxes.
2. **Monitoring** what agents are doing, live.
3. **Cost tracking** per run / agent / model.
4. **Agents supervising agents**, including a small, cheap agent that **routes** work to a more or less powerful model based on task difficulty or decision importance.

Consequence: no multi-tenancy, billing or heavy auth. Anything that does not serve one of the four points above is a candidate for cutting.

### 2. Run output: a branch or patch
A run takes a task and produces a branch or diff. A human decides what happens next. No PR automation required.

### 3. Agents: one harness behind an interface, model is the variable
Build a single agent harness and vary the **model** per run. `agent/` exposes an interface so a second harness could be added later, but only one is implemented. Reason: routing, cost tracking and supervision only need the model to vary; supporting several agent products would mean a separate event/usage/model-name translator for each.

### 4. Sandboxes: hosted sandbox service first
Specific vendor not chosen yet.

### 5. Supervisor powers: observe and flag, pause or kill, review the result
A supervising agent reads the worker's event stream and can raise alerts, stop a run, and judge the final diff before it is marked done. It does **not** steer (no injecting messages into the worker's conversation).

### 6. The agent loop runs inside the sandbox
The agent process runs on the disposable machine and streams events out. Follow-on consequence to resolve: model API credentials must reach the sandbox, most likely through a proxy that also meters cost.

### 7. Routing: triage up front, plus escalation
A cheap model classifies the task at intake and picks the starting worker model. During the run, the worker being stuck or the supervisor flagging a problem can escalate the run to a stronger model. Every routing decision is recorded with who made it, why, and its cost impact, so the dashboard can show it.

### 8. Harness: written ourselves
We write the agent loop, tools and history management rather than wrapping the Claude Agent SDK or Claude Code CLI. This allows routing across providers, including local models via Ollama, and demonstrates understanding of the internals. Accepted cost: significantly more work on the loop itself, so its scope must be kept tight (see open questions).

Implication: the harness needs a **model provider** interface (one `chat(messages, tools) -> reply + usage` shape) with an adapter per provider. Ollama is a provider adapter, not a harness.

### 9. Local models first; metrics centre on compute
Agents work mostly with local models (via Ollama or similar) so runs can go longer for less money, with few or no API keys injected into sandboxes. Dashboard metrics shift accordingly: wall-clock time, GPU/CPU seconds, tokens per second and sandbox cost matter more than per-token API price. Token counts are still recorded.

**Unresolved tension with decision 4 (hosted sandbox service):** most hosted sandboxes are CPU-only, small-memory VMs, which cannot run a coding-capable model at usable speed. Either the sandbox must have a GPU, or the model must live outside the worker sandbox on a machine we control. See open questions; decision 4 may need revising.

### 10. Everything runs in the cloud; one sandbox per run
Nothing runs on the developer's own machine. Each run gets exactly one sandbox. Constraints: sandboxes must not be slow, and GPU/compute spend must stay low.

Consequence: the model cannot live inside the per-run sandbox (that would mean one GPU and one copy of the weights per run). The shape is therefore **one cheap CPU sandbox per run for the agent + one shared model endpoint that all runs call**. This resolves the tension noted in decision 9; decision 4 stands, with the sandbox being CPU-only.

_Proposed, not yet confirmed:_ the shared model endpoint is a serverless GPU deployment that scales to zero when idle, reached through our gateway.

### 11. Open models only
No frontier/proprietary model tier. Escalation goes from a smaller open model to a larger open model.

### 12. Budget: €10 per month, total
Hard ceiling covering GPU time, sandboxes, any hosted inference, and hosting for the app itself. Consequences:
- Budget enforcement is a real requirement, not a nice-to-have: the gateway must be able to refuse work when the month's allowance is spent.
- The API, database and dashboard must fit free hosting tiers.
- Development and testing of the harness cannot depend on paid GPU time for every iteration.

The ceiling is a **hard stop**: once the month's allowance is spent the gateway refuses new runs, and the dashboard shows remaining budget.

### 13. Escalation to a large model is deferred, but designed for
First version hosts no large model, so there is one self-hosted deployment on serverless GPU (scales to zero) and no hosted-API key. This amends decision 7: triage still runs at intake, and the escalation path exists in the code, but there is no bigger tier to escalate to yet.

What "designed for" means concretely:
- The model provider interface and gateway support multiple providers and models from the start.
- A run's model is not fixed for its lifetime: the data model records a list of model assignments per run, each with who decided, why and when.
- The supervisor can emit an "escalate" verdict; with one tier it is recorded and surfaced as a flag rather than acted on.
- ~~A fake provider with scripted replies is built for development and tests.~~ Dropped by decision 20.

### 14. First-version routing: two model sizes on one GPU
Triage chooses between a small and a medium open model served from the same serverless GPU deployment. No second deployment. Accepted cost: swap time when the active model changes. Per-run effort limits (steps, time) still exist because the hard budget stop needs them, but they are not the routing mechanism.

### 15. Dashboard must-haves (first version)
All five:
1. Live feed of what each agent is doing.
2. Cost and compute per run.
3. Routing and supervisor decisions, with reasons.
4. The resulting diff.
5. Controls to start, pause and kill runs.

What this forces on the rest of the system:
- A structured, persisted **event log** per run is the backbone; the feed, cost view and decision view are all read from it.
- A **push channel** from server to browser for live updates.
- The harness loop must check for a **kill signal** between steps (pause was dropped for v1, see decision 18).
- The diff is captured from the sandbox and stored **before** the sandbox is destroyed.

### 16. Only the owner starts runs; visitors watch and replay
Starting and killing runs requires the owner's login. Everything else is public and read-only: visitors can watch a live run or replay any past run from its event log. Replay must work with the GPU cold and the budget spent.

### 17. Input is a public repo; output is a stored patch
The sandbox clones a public repository over HTTPS. The result is a diff saved to our database. Nothing is pushed anywhere, so the sandbox holds no git credentials. (This narrows decision 2 to "patch".)

### 18. No pause in v1
A run can be killed but not paused. Killing saves the diff so far, then destroys the sandbox immediately. This amends decision 15 item 5 to "start and kill" and decision 5 to "observe and flag, kill, review the result".

### Guiding constraint for v1
The target is a **working prototype**. When in doubt, choose the smaller option and put the rest in the parking lot.

### 19. Models are configuration, chosen later; start small
Specific models are not chosen yet. v1 starts with quite small models, and moving to larger ones must not require infrastructure changes. Concretely:
- Models are declared in a **model registry** (config, not code): name, provider, tier, context size, and the GPU rate used for costing.
- Router, gateway, harness and dashboard refer to tiers and registry entries, never to hard-coded model names.
- Swapping in a larger model means editing the registry and, if needed, the GPU size in `model-server/`. Nothing else changes.
- The harness must tolerate weak models: malformed tool calls are expected, reported back to the model, and counted as events rather than crashing the run.

### 20. No fake models or fake sandboxes; build against real ones from the start
There is no fake model provider and no fake sandbox provider. Development targets a real small model (a small Qwen, exact variant to be confirmed) and a real hosted sandbox from the first milestone. This overrides the fake-provider bullet in decision 13, the "Dev and tests" default, and the earlier fakes-first build order.

Consequences:
- The sandbox vendor and model hosting must be chosen **before** coding starts, not at a later milestone.
- Development spends from the €10 budget. Starting with a very small model keeps this low.
- The provider interfaces in `gateway/` and `sandbox-provider/` remain (decisions 3, 13, 19), each with one real implementation.
- Test policy without fakes is an open question (see below).

### 21. CPU-only model hosting to start
The starting model is served from CPU, not GPU, as a concept tester. The compute metric is CPU minutes for now. Moving to GPU is a hardware setting in `model-server/` plus a rate in the model registry; the dashboard labels compute by the hardware type in the registry rather than assuming "GPU". References to "serverless GPU" in earlier decisions read as "serverless model endpoint, CPU for now".

The model endpoint stays shared and outside the per-run sandbox (decision 10) even though a small CPU model could fit inside one, because triage and the supervisor run on the server and need a model too, and because it keeps the later GPU move a configuration change.

### 22. Vendor: Modal for both sandboxes and the model endpoint
Chosen on condition that it has a free tier, which was checked on modal.com/pricing on 2026-10-12: the Starter plan is $0 per month plus compute, with **$30 of free compute credit every month**. Confirmed rates: CPU $0.0000131 per core-second and memory $0.00000222 per GiB-second for functions; $0.00003942 and $0.00000667 for sandboxes (1 core = 2 vCPU).

Starter limits that matter here: 100 containers, 200 deployed apps, 1 day of log retention (so our own event log is the record, not Modal's logs), and no environment-level budgets (so the hard stop in our gateway is the only spending guard). The page says web functions are "limited" on Starter without giving the limit, and does not say whether a payment card is required; both to be checked at sign-up.

**Sign-up findings (2026-10-12):** the account (workspace `c-mckeon`) was created without a payment card and shows **$1 of free credit**, not $30. The $30 monthly credit presumably requires adding a card; this is unverified. No web-function limit is visible in the dashboard. At roughly $0.25 per hour for a 4-core CPU model endpoint and $0.19 per hour for a sandbox, $1 covers a few hours: enough for milestone 1's speed and tool-call measurements, not for the whole build. Decision on adding a card is open.

Accepted exception: `model-server/` is a small Python file, since Modal deployments are defined in Python.

### 23. Starting model: `qwen2.5-coder:1.5b` served by Ollama
On CPU (decision 21). The second, larger size for routing (decision 14) is chosen at the router milestone.

### 24. Test policy
Plain-code parts (harness tools, tool-call parser, run state machine, cost arithmetic, budget check) get ordinary automated tests that need no model or sandbox. A small number of end-to-end tests call the real model and a real sandbox and are run by hand, not on every change.

### Measurement: first smoke test of the starting model (2026-10-12)
`model-server/smoke_test.py`, run once as an ephemeral Modal app: `qwen2.5-coder:1.5b` under Ollama 0.40.3 on 4 CPU cores and 4 GiB, two prompts. A sample of one, so indicative only.

| | Result |
| --- | --- |
| Output speed | ~26 tokens per second |
| Prompt reading speed | ~330–430 tokens per second |
| Model load on cold start | 3.5 s; whole container lived ~10.5 s |
| Plain coding prompt | Correct iterative Fibonacci function, 6.6 s including load |
| Tool-call prompt | Chose the right tool and the right file, in 2 s, **but** returned the call as plain text in the message body, not in Ollama's structured `tool_calls` field, and wrapped the argument in a copy of the schema (`"path": {"type": "string", ..., "value": "src/config.ts"}`) instead of `"path": "src/config.ts"` |

Conclusions:
- CPU speed is adequate for a concept tester (decision 21 holds).
- The harness cannot rely on Ollama's structured tool calls with this model. It needs its own lenient parser that finds a JSON tool call in the text and repairs common shape errors, plus the error-feedback loop already planned in decision 19. Prompting with an explicit example of the expected call format is worth testing.

## Defaults (confirmed 2026-10-12)

Chosen to keep v1 small.

| Topic | Default | Reason |
| --- | --- | --- |
| Language | TypeScript on Node for every component | One language across API, orchestrator, harness and UI |
| Concurrency | One run at a time | One GPU serving two models; parallel runs would fight over model swaps |
| Run states | `queued → triaging → running → reviewing → done`, plus `failed`, `killed`, `budget_stopped` | Minimum that covers triage, review and the hard stop |
| Harness tools | Read file, write/edit file, search files, run shell command | Enough for real coding tasks |
| Harness non-goals | Subagents, MCP, smart context compaction (simple truncation only) | Not headline features |
| Supervisor wake-up | Cheap code rules on every event (repeated command, repeated failure, step/time limit); a model is called only when a rule fires, and once at the end to review the diff | Keeps supervision cheaper than the work |
| Metering | At the gateway: tokens, latency and GPU seconds per call, attributed to run and role (triage / worker / supervisor) | One place, uniform for every role |
| Cost definition | GPU seconds × GPU rate + sandbox seconds × sandbox rate; tokens recorded but not priced | Compute-centred, per decision 9 |
| Sandbox → server | Agent posts events to the API using a short-lived per-run token | The only credential in the sandbox, and it expires with the run |
| Server → browser | Server-Sent Events | One-way live feed; simpler than WebSockets |
| Database | Hosted Postgres on a free tier; tables for runs, events, model assignments, usage, patches | All-cloud, zero cost |
| Dashboard | React single-page app served by the API | Conventional |
| Owner auth | Single owner account; no sign-up | Decision 16 |
| Dev and tests | ~~Fake model and sandbox providers~~ — superseded by decision 20: real model and real sandbox | |

## Vendor comparison (researched 2026-10-12; outcome: Modal, decision 22)

Prices are from web search on the date above. Modal's rates and free credit were then confirmed on its own pricing page. All bill per second.

| | Modal | E2B | Daytona | Google Cloud Run |
| --- | --- | --- | --- | --- |
| Role it can fill | Sandbox **and** model endpoint | Sandbox only | Sandbox only (GPU exists, large cards only) | Model endpoint only |
| CPU rate | Sandbox: ~$0.0000394 per core-second (1 core = 2 vCPU). Functions: ~$0.0000131 per core-second | $0.000014 per vCPU-second | $0.0504 per vCPU-hour | ~$0.000024 per vCPU-second |
| Memory rate | ~$0.00000222 per GiB-second (3× in sandboxes) | $0.0000045 per GiB-second | $0.0162 per GiB-hour | ~$0.0000025 per GiB-second |
| 2 vCPU + 2 GiB sandbox | ~$0.19 per hour | ~$0.13 per hour | ~$0.13 per hour | n/a |
| Free allowance | $30 of credit **every month** | $100 credit, one-time | $200 credit, one-time | 180,000 vCPU-seconds and 360,000 GiB-seconds every month |
| Scale to zero | Yes | n/a | n/a | Yes |
| GPU later | Yes, a setting on the same deployment | No | Limited | Yes |
| Fit with TypeScript-everywhere | Sandboxes usable from TypeScript; the model deployment is defined in a small Python file | TypeScript SDK | TypeScript SDK | Any container |

Rough cost of one hour of active run time (one sandbox plus a 4-core CPU model endpoint): about $0.40–0.45 before free allowances. €10 therefore covers roughly 25 run-hours a month even with no free credit.

**Recommendation: Modal for both roles.** One vendor and one bill; the recurring $30 monthly credit is larger than the whole €10 budget, so expected out-of-pocket spend is near zero; and adding a GPU later is a setting rather than a migration (decisions 19, 21). Costs: its sandbox rate is the highest of the three, and `model-server/` would be a small Python file, the one exception to TypeScript-everywhere.

**Alternative: E2B or Daytona for sandboxes plus Cloud Run for the model.** Cheaper sandbox rate and all-TypeScript, but two vendors, two bills to reconcile for the cost view, and the sandbox credits are one-time.

Starting model candidate: `qwen2.5-coder:1.5b` served by Ollama (to be confirmed). No CPU speed or tool-calling benchmarks were found; measuring both is the first job of milestone 1.

Sources: [E2B pricing](https://www.e2b.dev/pricing), [E2B billing docs](https://e2b.dev/docs/billing), [Daytona pricing](https://www.daytona.io/pricing), [Daytona on agentdeals.dev](https://agentdeals.dev/vendor/daytona), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Modal pricing (morphllm)](https://www.morphllm.com/modal-pricing), [Modal pricing explained (beam.cloud)](https://www.beam.cloud/blog/modal-pricing-explained), [Modal vs E2B sandbox cost](https://www.agenticwire.news/article/e2b-vs-modal-agent-sandbox-cost-comparison)

## Revised architecture

| Module | Responsibility |
| --- | --- |
| `config.ts` | environment ↔ application |
| `api/` | HTTP: start/kill runs, event ingest from sandboxes, live stream and replay for the dashboard |
| `orchestrator/` | run lifecycle state machine; creates and destroys the sandbox; captures the patch |
| `router/` | triage: small model rates the task and picks the model; records the decision and reason |
| `supervisor/` | rule checks on the event stream, model verdicts, final diff review; can kill or flag |
| `gateway/` | model provider interface and adapters (self-hosted now; hosted API later), metering, budget hard stop |
| `db/` | application ↔ persistent state |
| `sandbox-provider/` | orchestrator ↔ disposable computers (one hosted vendor) |
| `sandbox/` | image definition: what is installed on those computers |
| `agent/` | the harness: loop, tools, event emission; runs inside the sandbox |
| `model-server/` | definition of the serverless GPU deployment serving both model sizes |
| `web/` | dashboard UI |
| `tests/` | proves those boundaries actually work |

## Open questions

None blocking. To check or measure during the build:

- **Modal credit:** only $1 is available without a payment card. Decide whether to add a card (and confirm that unlocks $30 per month, and whether Modal offers a workspace spending cap), or to stay card-free and reconsider vendors after milestone 1
- Milestone 1: measured CPU speed and tool-call reliability of the starting model; if unusable, revisit model size or hardware before going further
- Milestone 6: which larger model is the second routing tier
- Milestone 8: which free-tier hosts for the API, database and dashboard

## Architecture page

`web/architecture.html` illustrates the architecture one build step at a time: a dropdown per step, the current step open, each with a diagram of what the step adds, the biggest questions at that version, and a snapshot of the project folder explaining each file and its links to cloud services. It is updated whenever a step starts or finishes; earlier steps' snapshots are left as they were.

## Build order (confirmed 2026-10-12)

Real services from the first milestone (decision 20).

0. **Sign up for Modal** and confirm the two sign-up checks above.
1. **Model endpoint and gateway.** `model-server/` serving the starting model; `gateway/` with the self-hosted adapter, model registry, metering and the budget hard stop. The hard stop comes first because every later step spends money.
2. **Sandbox.** `sandbox-provider/` and the `sandbox/` image; create, run a command, destroy.
3. **Skeleton.** `config`, `db`, `api`, `orchestrator` with the run state machine; per-run token; events stored.
4. **Harness.** The `agent/` loop and four tools running in the sandbox against the real model; tolerates malformed tool calls; produces a patch from a cloned public repo.
5. **Dashboard.** Live feed over SSE, replay from the event log, diff view, cost view, start and kill, owner login.
6. **Router.** Add the second model size; triage picks the tier; decisions and reasons recorded and shown.
7. **Supervisor.** Rules, model verdicts, final review, kill; "escalate" verdict recorded as a flag.
8. **Deploy.** Free-tier hosting for API, database and dashboard; seed a few good recorded runs for visitors to replay.

## Parking lot

_Things raised but deferred._

- Large-model escalation tier, likely via a hosted open-model API with its key held in the gateway (decision 13).
- A second harness behind the `agent/` interface (decision 3).
- Supervisor steering the worker by injecting messages (decision 5).
- Pause and resume of runs (decision 18).
- Pushing the patch as a branch, done by the server rather than the sandbox (decision 17).
- Visitors starting runs from a preset menu under a daily allowance (decision 16).
- Parallel runs.
