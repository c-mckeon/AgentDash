"""Gateway rules with no cloud or web dependencies: registry, pricing, budget, validation.

Kept free of Modal and FastAPI imports so it can be unit-tested anywhere and
moved into another server later without changes.
"""

from dataclasses import asdict, dataclass
from datetime import datetime

# Modal's listed rates for functions (USD). Sandboxes are priced separately.
CPU_CORE_SECOND_USD = 0.0000131
MEMORY_GIB_SECOND_USD = 0.00000222

# Hard stop for the calendar month (UTC), in the currency Modal bills in.
# Deliberately below the 10 EUR ceiling while the account runs on $1 of free credit.
MONTHLY_BUDGET_USD = 0.50

MAX_OUTPUT_TOKENS = 1024
DEFAULT_OUTPUT_TOKENS = 512
ROLES = ("worker", "triage", "supervisor", "manual")
MESSAGE_ROLES = ("system", "user", "assistant", "tool")


@dataclass(frozen=True)
class ModelEntry:
    tier: str
    model: str
    provider: str
    hardware: str  # "cpu" or "gpu"; the dashboard labels compute with this
    cpu_cores: float
    memory_gib: float
    context_tokens: int
    # How long the machine stays up, and billed, after its last call.
    # Must match SCALEDOWN_SECONDS in model-server/serve.py.
    idle_window_seconds: float

    @property
    def usd_per_second(self) -> float:
        return self.cpu_cores * CPU_CORE_SECOND_USD + self.memory_gib * MEMORY_GIB_SECOND_USD

    def public(self) -> dict:
        return {**asdict(self), "usd_per_second": self.usd_per_second}


# The model registry. Adding a model or a tier is a new entry here (plus pulling
# it in model-server/serve.py); callers ask for a tier and never name a model.
REGISTRY = {
    "small": ModelEntry(
        tier="small",
        model="qwen2.5-coder:1.5b",
        provider="modal-ollama",
        hardware="cpu",
        cpu_cores=4,
        memory_gib=4,
        context_tokens=4096,
        idle_window_seconds=60,
    ),
}


def month_key(now: datetime) -> str:
    return now.strftime("%Y-%m")


def cost_usd(entry: ModelEntry, seconds: float) -> float:
    return max(seconds, 0.0) * entry.usd_per_second


def idle_seconds(previous_end: float | None, started: float, window: float) -> float:
    """Seconds the machine sat idle but still billed since the previous call ended.

    The machine stays up for `window` seconds after a call. If the next call
    comes sooner, the whole gap was billed; if later, only the window was.
    """
    if previous_end is None:
        return 0.0
    return min(max(started - previous_end, 0.0), window)


def budget_status(spent_usd: float, limit_usd: float = MONTHLY_BUDGET_USD) -> dict:
    return {
        "spent_usd": round(spent_usd, 6),
        "limit_usd": limit_usd,
        "remaining_usd": round(max(limit_usd - spent_usd, 0.0), 6),
        "exhausted": spent_usd >= limit_usd,
    }


def total_spent(records: list[dict]) -> float:
    return sum(record.get("cost_usd", 0.0) for record in records)


def summarise(records: list[dict]) -> dict:
    """Totals for a list of ledger records, overall and per role."""
    by_role: dict[str, dict] = {}
    for record in records:
        bucket = by_role.setdefault(
            record.get("role", "manual"),
            {
                "calls": 0,
                "cost_usd": 0.0,
                "billed_seconds": 0.0,
                "idle_seconds": 0.0,
                "prompt_tokens": 0,
                "output_tokens": 0,
            },
        )
        bucket["calls"] += 1
        bucket["cost_usd"] += record.get("cost_usd", 0.0)
        bucket["billed_seconds"] += record.get("billed_seconds", 0.0)
        bucket["idle_seconds"] += record.get("idle_seconds", 0.0)
        bucket["prompt_tokens"] += record.get("prompt_tokens", 0)
        bucket["output_tokens"] += record.get("output_tokens", 0)
    for bucket in by_role.values():
        bucket["cost_usd"] = round(bucket["cost_usd"], 6)
        bucket["billed_seconds"] = round(bucket["billed_seconds"], 3)
        bucket["idle_seconds"] = round(bucket["idle_seconds"], 3)
    return {
        "calls": len(records),
        "cost_usd": round(total_spent(records), 6),
        "billed_seconds": round(sum(r.get("billed_seconds", 0.0) for r in records), 3),
        "idle_seconds": round(sum(r.get("idle_seconds", 0.0) for r in records), 3),
        "by_role": by_role,
    }


def validate_chat_request(body) -> tuple[dict | None, str | None]:
    """Return (clean request, None) or (None, reason it was rejected)."""
    if not isinstance(body, dict):
        return None, "body must be a JSON object"

    tier = body.get("tier", "small")
    if tier not in REGISTRY:
        return None, f"unknown tier {tier!r}; known tiers: {sorted(REGISTRY)}"

    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return None, "messages must be a non-empty list"
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in MESSAGE_ROLES:
            return None, f"each message needs a role from {MESSAGE_ROLES}"
        if not isinstance(message.get("content", ""), str):
            return None, "message content must be a string"

    tools = body.get("tools")
    if tools is not None and not isinstance(tools, list):
        return None, "tools must be a list"

    role = body.get("role", "manual")
    if role not in ROLES:
        return None, f"role must be one of {ROLES}"

    run_id = body.get("run_id")
    if run_id is not None and (not isinstance(run_id, str) or len(run_id) > 100):
        return None, "run_id must be a string of at most 100 characters"

    max_tokens = body.get("max_tokens", DEFAULT_OUTPUT_TOKENS)
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens < 1:
        return None, "max_tokens must be a positive integer"

    temperature = body.get("temperature", 0)
    if not isinstance(temperature, (int, float)) or isinstance(temperature, bool) or not 0 <= temperature <= 2:
        return None, "temperature must be a number between 0 and 2"

    return {
        "tier": tier,
        "messages": messages,
        "tools": tools,
        "role": role,
        "run_id": run_id,
        "max_tokens": min(max_tokens, MAX_OUTPUT_TOKENS),
        "temperature": temperature,
    }, None


def last_end(records: list[dict], tier: str) -> float | None:
    """When the most recent call to this tier's machine ended, if known."""
    for record in reversed(records):
        if record.get("tier") == tier and record.get("ended_at") is not None:
            return record["ended_at"]
    return None


def make_record(
    *,
    at: datetime,
    request: dict,
    entry: ModelEntry,
    billed_seconds: float,
    idle: float,
    ended_at: float,
    reply: dict,
) -> dict:
    """One ledger line for one model call.

    `billed_seconds` is the call itself (including any cold start or queueing);
    `idle` is the billed idle time that preceded it. Both are charged here.
    """
    return {
        "at": at.isoformat(timespec="seconds"),
        "ended_at": round(ended_at, 3),
        "run_id": request["run_id"],
        "role": request["role"],
        "tier": entry.tier,
        "model": entry.model,
        "hardware": entry.hardware,
        "billed_seconds": round(billed_seconds, 3),
        "idle_seconds": round(idle, 3),
        "model_seconds": reply.get("model_seconds", 0.0),
        "prompt_tokens": reply.get("prompt_eval_count", 0),
        "output_tokens": reply.get("eval_count", 0),
        "cost_usd": round(cost_usd(entry, billed_seconds + idle), 8),
        "error": reply.get("error"),
    }
