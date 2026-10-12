"""The model service: Ollama serving the registry's models on a Modal CPU machine.

Deploy with:  py -m modal deploy model-server/serve.py

Not reachable from the internet. Only other Modal code in this workspace (the
gateway) can call it. A machine starts when a call arrives and shuts down
after SCALEDOWN_SECONDS without one.
"""

import json
import subprocess
import time
import urllib.error
import urllib.request

import modal

MODELS = ["qwen2.5-coder:1.5b"]
# Hardware must match what gateway/core.py records for these models, because
# the gateway prices each call from those numbers.
CPU_CORES = 4  # Modal physical cores (1 core = 2 vCPU)
MEMORY_MIB = 4096
SCALEDOWN_SECONDS = 60
OLLAMA_URL = "http://127.0.0.1:11434"

image = (
    modal.Image.from_registry("ollama/ollama:latest", add_python="3.12")
    .entrypoint([])
    .env({"OLLAMA_MODELS": "/models"})
    # Bake the weights into the image so a cold start does not download them.
    .run_commands("ollama serve & sleep 5 && " + " && ".join(f"ollama pull {m}" for m in MODELS))
)

app = modal.App("agentdash-model")


@app.cls(
    image=image,
    cpu=CPU_CORES,
    memory=MEMORY_MIB,
    timeout=600,
    scaledown_window=SCALEDOWN_SECONDS,
    max_containers=1,
)
class Model:
    @modal.enter()
    def start(self):
        self.server = subprocess.Popen(
            ["ollama", "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        for _ in range(60):
            try:
                urllib.request.urlopen(OLLAMA_URL + "/api/version", timeout=2)
                return
            except OSError:
                time.sleep(0.5)
        raise RuntimeError("ollama did not start")

    @modal.exit()
    def stop(self):
        self.server.terminate()

    @modal.method()
    def chat(
        self,
        model: str,
        messages: list,
        tools: list | None = None,
        options: dict | None = None,
        response_format: str | dict | None = None,
    ) -> dict:
        """Forward one chat request to Ollama and return its reply plus timing.

        `response_format` is "json" or a JSON schema; Ollama then constrains
        the model's output to match it.
        """
        if model not in MODELS:
            return {"error": f"model {model!r} is not installed on this machine"}

        body = {"model": model, "messages": messages, "stream": False, "options": options or {}}
        if tools:
            body["tools"] = tools
        if response_format:
            body["format"] = response_format
        request = urllib.request.Request(
            OLLAMA_URL + "/api/chat",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=540) as response:
                reply = json.loads(response.read())
        except urllib.error.HTTPError as error:
            reply = {"error": error.read().decode(errors="replace")}
        reply["model_seconds"] = round(time.monotonic() - started, 3)
        return reply
