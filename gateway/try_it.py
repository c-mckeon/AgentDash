"""Send one prompt through the deployed gateway, or show the month's usage.

    py gateway/try_it.py "Write a haiku about queues"
    py gateway/try_it.py --usage

Reads GATEWAY_URL and GATEWAY_KEY from the .env file in the project root.
"""

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path


def load_env() -> dict:
    env = {}
    for line in (Path(__file__).resolve().parent.parent / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def call(env: dict, path: str, body: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        env["GATEWAY_URL"].rstrip("/") + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {env['GATEWAY_KEY']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def main() -> None:
    env = load_env()
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    if sys.argv[1] == "--usage":
        status, reply = call(env, "/v1/usage")
    else:
        status, reply = call(
            env,
            "/v1/chat",
            {"messages": [{"role": "user", "content": sys.argv[1]}], "role": "manual", "max_tokens": 200},
        )
    print(status)
    print(json.dumps(reply, indent=2))


if __name__ == "__main__":
    main()
