"""One-off smoke test: run the starting model on CPU and time two prompts.

Run with:  py -m modal run model-server/smoke_test.py

Runs as an ephemeral app, so nothing stays deployed and billing stops when the
function returns. The function timeout caps the spend if something hangs.
"""

import json
import subprocess
import time
import urllib.error
import urllib.request

import modal

MODEL = "qwen2.5-coder:1.5b"
CPU_CORES = 4  # Modal physical cores (1 core = 2 vCPU)
MEMORY_MIB = 4096
OLLAMA_URL = "http://127.0.0.1:11434"

image = (
    modal.Image.from_registry("ollama/ollama:latest", add_python="3.12")
    .entrypoint([])
    .env({"OLLAMA_MODELS": "/models"})
    # Bake the weights into the image so a cold start does not download them.
    .run_commands(f"ollama serve & sleep 5 && ollama pull {MODEL}")
)

app = modal.App("agentdash-model-smoke-test")

READ_FILE_TOOL = {
    "type": "function",
    "function": {
        "name": "read_file",
        "description": "Read a file from the repository and return its contents.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to the repo root"}
            },
            "required": ["path"],
        },
    },
}


def _post(path: str, body: dict) -> dict:
    request = urllib.request.Request(
        OLLAMA_URL + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=240) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        return {"error": error.read().decode(errors="replace")}


def _wait_for_server() -> None:
    for _ in range(60):
        try:
            urllib.request.urlopen(OLLAMA_URL + "/api/version", timeout=2)
            return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("ollama did not start")


def _chat(label: str, messages: list, tools: list | None = None) -> dict:
    body = {
        "model": MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": 200, "temperature": 0},
    }
    if tools:
        body["tools"] = tools
    started = time.monotonic()
    reply = _post("/api/chat", body)
    wall_seconds = time.monotonic() - started
    if "error" in reply:
        return {"label": label, "error": reply["error"], "wall_seconds": round(wall_seconds, 2)}

    message = reply.get("message", {})
    eval_seconds = reply.get("eval_duration", 0) / 1e9
    prompt_seconds = reply.get("prompt_eval_duration", 0) / 1e9
    return {
        "label": label,
        "wall_seconds": round(wall_seconds, 2),
        "load_seconds": round(reply.get("load_duration", 0) / 1e9, 2),
        "prompt_tokens": reply.get("prompt_eval_count", 0),
        "prompt_tokens_per_second": round(reply.get("prompt_eval_count", 0) / prompt_seconds, 1)
        if prompt_seconds
        else None,
        "output_tokens": reply.get("eval_count", 0),
        "output_tokens_per_second": round(reply.get("eval_count", 0) / eval_seconds, 1)
        if eval_seconds
        else None,
        "content": message.get("content", ""),
        "tool_calls": message.get("tool_calls"),
    }


@app.function(image=image, cpu=CPU_CORES, memory=MEMORY_MIB, timeout=300)
def run_prompts() -> dict:
    container_started = time.monotonic()
    server = subprocess.Popen(["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        _wait_for_server()
        results = [
            _chat(
                "plain",
                [
                    {
                        "role": "user",
                        "content": "Write a Python function that returns the n-th Fibonacci number iteratively. Code only.",
                    }
                ],
            ),
            _chat(
                "tool_call",
                [
                    {
                        "role": "system",
                        "content": "You are a coding agent. Use the provided tools to inspect the repository before answering.",
                    },
                    {"role": "user", "content": "What does the file src/config.ts export?"},
                ],
                tools=[READ_FILE_TOOL],
            ),
        ]
    finally:
        server.terminate()
    return {
        "model": MODEL,
        "cpu_cores": CPU_CORES,
        "memory_mib": MEMORY_MIB,
        "container_seconds": round(time.monotonic() - container_started, 2),
        "results": results,
    }


@app.local_entrypoint()
def main():
    print(json.dumps(run_prompts.remote(), indent=2))
