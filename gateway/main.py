"""The gateway: the one public door to the models.

Deploy with:  py -m modal deploy gateway/main.py   (after model-server/serve.py)

Every model request comes through here. The gateway checks the caller's key,
refuses once the month's budget is spent, forwards to the model service,
and writes one ledger line per call. The rules live in core.py; this file is
only the web and Modal wiring.
"""

import asyncio
import hmac
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import modal

import core

MODEL_APP = "agentdash-model"
LEDGER_DIR = Path("/ledger")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]")
    .add_local_python_source("core")
)

# One JSON-lines file per month. Stands in for the database until step 3.
ledger_volume = modal.Volume.from_name("agentdash-ledger", create_if_missing=True)

app = modal.App("agentdash-gateway")


def read_ledger(month: str) -> list[dict]:
    path = LEDGER_DIR / f"{month}.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def append_ledger(month: str, record: dict) -> None:
    with open(LEDGER_DIR / f"{month}.jsonl", "a") as file:
        file.write(json.dumps(record) + "\n")


@app.function(
    image=image,
    secrets=[modal.Secret.from_name("agentdash-gateway")],
    volumes={str(LEDGER_DIR): ledger_volume},
    cpu=0.25,
    memory=256,
    timeout=600,
    scaledown_window=60,
    # A single container, so the lock below really does serialise budget checks.
    max_containers=1,
)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def web():
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse

    api = FastAPI(title="AgentDash gateway")
    model = modal.Cls.from_name(MODEL_APP, "Model")()
    # Held from budget check to ledger write, so two calls cannot both pass the
    # check on the last cent. The model handles one request at a time anyway.
    lock = asyncio.Lock()
    # Modal's own metered cost for the month: the truth the hard stop is checked
    # against. It covers everything in the workspace, not just model calls.
    vendor = {"usd": None, "at": 0.0, "error": None}

    async def vendor_spend() -> float | None:
        if time.time() - vendor["at"] < 60:
            return vendor["usd"]
        try:
            summary = await asyncio.to_thread(
                lambda: modal.Workspace.from_context().billing.summary(cycle="this month")
            )
            vendor["usd"] = max(
                float(summary.metered_cost), float(sum(summary.metered_cost_breakdown.values()))
            )
            vendor["error"] = None
        except Exception as error:  # keep the last known figure and fall back to the ledger
            vendor["error"] = str(error)[:200]
        vendor["at"] = time.time()
        return vendor["usd"]

    def authorised(request: Request) -> bool:
        expected = os.environ["GATEWAY_KEY"]
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return hmac.compare_digest(supplied.encode(), expected.encode())

    def run_from_pass(request: Request) -> str | None:
        """The run id if the caller holds a valid per-run pass."""
        supplied = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        return core.verify_run_token(os.environ["GATEWAY_KEY"], supplied, time.time())

    def denied():
        return JSONResponse({"error": "unauthorised"}, status_code=401)

    @api.get("/health")
    async def health():
        return {"ok": True}

    @api.get("/v1/models")
    async def models(request: Request):
        if not authorised(request):
            return denied()
        return {"models": [entry.public() for entry in core.REGISTRY.values()]}

    @api.get("/v1/usage")
    async def usage(request: Request):
        if not authorised(request):
            return denied()
        month = core.month_key(datetime.now(timezone.utc))
        records = read_ledger(month)
        return {
            "month": month,
            "budget": core.budget_view(core.total_spent(records), await vendor_spend()),
            "vendor_meter_error": vendor["error"],
            "summary": core.summarise(records),
            "recent": records[-20:],
        }

    @api.post("/v1/chat")
    async def chat(request: Request):
        # The owner key may call as any role. A per-run pass, which is all a
        # sandbox holds, may only call as that run's worker.
        pass_run_id = None if authorised(request) else run_from_pass(request)
        if not authorised(request) and pass_run_id is None:
            return denied()
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"error": "body is not valid JSON"}, status_code=400)
        clean, problem = core.validate_chat_request(body)
        if problem:
            return JSONResponse({"error": problem}, status_code=400)
        if pass_run_id is not None:
            clean["run_id"] = pass_run_id
            clean["role"] = "worker"
        entry = core.REGISTRY[clean["tier"]]

        async with lock:
            now = datetime.now(timezone.utc)
            month = core.month_key(now)
            records = read_ledger(month)
            ledger_usd = core.total_spent(records)
            vendor_usd = await vendor_spend()
            budget = core.budget_view(ledger_usd, vendor_usd)
            if budget["exhausted"]:
                return JSONResponse({"error": "budget_exhausted", "budget": budget}, status_code=402)

            idle = core.idle_seconds(
                core.last_end(records, entry.tier),
                time.time(),
                entry.idle_window_seconds,
                entry.wake_overhead_seconds,
            )
            # Timed from here, so a cold start or a wait in the queue is billed too.
            started = time.monotonic()
            try:
                reply = await model.chat.remote.aio(
                    entry.model,
                    clean["messages"],
                    clean["tools"],
                    {
                        "num_predict": clean["max_tokens"],
                        "temperature": clean["temperature"],
                        "num_thread": entry.num_threads,
                    },
                    clean["response_format"],
                )
            except Exception as error:  # the machine failed, timed out, or is not deployed
                reply = {"error": f"model service failed: {error}"}
            billed_seconds = time.monotonic() - started

            record = core.make_record(
                at=now,
                request=clean,
                entry=entry,
                billed_seconds=billed_seconds,
                idle=idle,
                ended_at=time.time(),
                reply=reply,
            )
            append_ledger(month, record)
            await ledger_volume.commit.aio()
            budget = core.budget_view(ledger_usd + record["cost_usd"], vendor_usd)

        usage_out = {
            key: record[key]
            for key in (
                "prompt_tokens",
                "output_tokens",
                "model_seconds",
                "billed_seconds",
                "idle_seconds",
                "cost_usd",
                "hardware",
            )
        }
        if reply.get("error"):
            return JSONResponse(
                {"error": reply["error"], "usage": usage_out, "budget": budget}, status_code=502
            )
        return {
            "tier": entry.tier,
            "model": entry.model,
            "message": reply.get("message", {}),
            "usage": usage_out,
            "budget": budget,
        }

    return api
