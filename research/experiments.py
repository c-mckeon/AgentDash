"""Small, grounded experiments against the deployed gateway.

    py research/experiments.py billing-snapshot
    py research/experiments.py wake --calls 1 --max-tokens 5 --gap 0
    py research/experiments.py tools
    py research/experiments.py context
    py research/experiments.py followup

Each command prints JSON and appends it to research/results/<date>.jsonl.
Every model call goes through the gateway, so the budget hard stop applies.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "gateway"))
import try_it  # noqa: E402

ENV = try_it.load_env()
RESULTS = ROOT / "research" / "results"


def save(kind: str, data: dict) -> None:
    RESULTS.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)
    line = {"at": now.isoformat(timespec="seconds"), "experiment": kind, **data}
    with open(RESULTS / f"{now:%Y-%m-%d}.jsonl", "a", encoding="utf-8") as file:
        file.write(json.dumps(line) + "\n")
    print(json.dumps(line, indent=2))


def chat(messages: list, **extra) -> dict:
    status, reply = try_it.call(ENV, "/v1/chat", {"messages": messages, "role": "manual", **extra})
    reply["status"] = status
    return reply


def usage() -> dict:
    return try_it.call(ENV, "/v1/usage")[1]


# ---------------------------------------------------------------- billing


def billing_by_app() -> dict:
    """Modal's own metered cost today, as {app: {resource: usd}}."""
    result = subprocess.run(
        [sys.executable, "-m", "modal", "billing", "report", "--for", "today", "--show-resources", "--json"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=ROOT,
    )
    totals: dict[str, dict[str, float]] = {}
    for row in json.loads(result.stdout):
        app = totals.setdefault(row["description"], {})
        app[row["resource"]] = app.get(row["resource"], 0.0) + float(row["cost"])
    return totals


def cmd_billing_snapshot(args) -> None:
    ledger = usage()
    save("billing_snapshot", {"modal": billing_by_app(), "budget": ledger["budget"]})


def cmd_wake(args) -> None:
    """One controlled wake of the model machine: N calls, a fixed gap apart."""
    prompt = "Count from 1 upwards, one number per line, and do not stop."
    before = usage()["budget"]["ledger_usd"]
    calls = []
    started = time.time()
    for index in range(args.calls):
        if index:
            time.sleep(args.gap)
        reply = chat([{"role": "user", "content": prompt}], max_tokens=args.max_tokens)
        calls.append(reply.get("usage", {"error": reply.get("error")}))
    save(
        "wake",
        {
            "label": args.label,
            "calls": calls,
            "first_call_at": started,
            "last_call_ended_at": time.time(),
            "ledger_delta_usd": round(usage()["budget"]["ledger_usd"] - before, 8),
        },
    )


# ---------------------------------------------------------------- tool calls

TOOL_SPECS = {
    "read_file": ("Read a file and return its contents.", {"path": "Path relative to the repo root"}),
    "write_file": (
        "Create or overwrite a file.",
        {"path": "Path relative to the repo root", "content": "Full text of the file"},
    ),
    "search_files": ("Search all files for a text pattern.", {"pattern": "Text to search for"}),
    "run_shell": ("Run a shell command in the repo root.", {"command": "The command line to run"}),
}

NATIVE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {arg: {"type": "string", "description": text} for arg, text in args.items()},
                "required": list(args),
            },
        },
    }
    for name, (description, args) in TOOL_SPECS.items()
]

NATIVE_SYSTEM = "You are a coding agent working in a code repository. Use a tool to act on the user's request."

PROMPTED_SYSTEM = (
    "You are a coding agent working in a code repository. You act only by calling tools.\n\n"
    "Tools:\n"
    + "\n".join(
        f"- {name}({', '.join(args)}): {description}" for name, (description, args) in TOOL_SPECS.items()
    )
    + "\n\nReply with exactly one JSON object and nothing else, in this form:\n"
    '{"tool": "<tool name>", "args": {"<argument>": "<value>"}}\n\n'
    'Example: {"tool": "read_file", "args": {"path": "src/app.py"}}'
)

CALL_SCHEMA = {
    "type": "object",
    "properties": {"tool": {"type": "string", "enum": list(TOOL_SPECS)}, "args": {"type": "object"}},
    "required": ["tool", "args"],
}

# (request, expected tool, {argument: text the value must contain})
TASKS = [
    ("Show me what is in README.md", "read_file", {"path": "README.md"}),
    ("What does src/config.ts export?", "read_file", {"path": "src/config.ts"}),
    ("Find every place the function parseDate is used.", "search_files", {"pattern": "parseDate"}),
    ("Run the test suite with npm test.", "run_shell", {"command": "npm test"}),
    ("Create a file named notes.txt containing the word hello.", "write_file", {"path": "notes.txt", "content": "hello"}),
    ("Which files mention TODO?", "search_files", {"pattern": "TODO"}),
    ("List the files in the current directory.", "run_shell", {"command": "ls"}),
    ("Open package.json so we can check the dependencies.", "read_file", {"path": "package.json"}),
    ("Check which version of git is installed.", "run_shell", {"command": "git"}),
    ("Add a .gitignore file that ignores node_modules.", "write_file", {"path": ".gitignore", "content": "node_modules"}),
]

ARMS = {
    "native_tools": {"system": NATIVE_SYSTEM, "extra": {"tools": NATIVE_TOOLS}},
    "prompted_json": {"system": PROMPTED_SYSTEM, "extra": {}},
    "prompted_json_mode": {"system": PROMPTED_SYSTEM, "extra": {"response_format": "json"}},
    "prompted_schema": {"system": PROMPTED_SYSTEM, "extra": {"response_format": CALL_SCHEMA}},
}


def first_json_object(text: str):
    """The first balanced {...} in the text that parses as JSON, else None."""
    for start in (match.start() for match in re.finditer(r"\{", text)):
        depth = 0
        in_string = escaped = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    in_string = False
            elif char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : index + 1])
                    except ValueError:
                        break
    return None


def unwrap(value):
    """Repair the schema-echo mistake: {"type": "string", "value": "x"} -> "x"."""
    if isinstance(value, dict) and "value" in value:
        return value["value"]
    return value


def extract_call(message: dict) -> tuple[str | None, dict, str]:
    """(tool, args, channel) from a model reply; channel says how it was found."""
    structured = message.get("tool_calls")
    if structured:
        function = structured[0].get("function", {})
        return function.get("name"), function.get("arguments") or {}, "structured"
    content = (message.get("content") or "").strip()
    whole = None
    try:
        whole = json.loads(content)
    except ValueError:
        pass
    found = whole if isinstance(whole, dict) else first_json_object(content)
    if not isinstance(found, dict):
        return None, {}, "none"
    tool = found.get("tool") or found.get("name")
    args = found.get("args") or found.get("arguments") or found.get("parameters") or {}
    return tool, args if isinstance(args, dict) else {}, "exact_json" if isinstance(whole, dict) else "embedded_json"


def grade(message: dict, expected_tool: str, expected_args: dict) -> dict:
    tool, args, channel = extract_call(message)

    def args_ok(repair: bool) -> bool:
        for name, needle in expected_args.items():
            value = unwrap(args.get(name)) if repair else args.get(name)
            if not isinstance(value, str) or needle.lower() not in value.lower():
                return False
        return True

    if channel == "none":
        verdict = "unparseable"
    elif tool != expected_tool:
        verdict = "wrong_tool"
    elif channel in ("structured", "exact_json") and args_ok(repair=False):
        verdict = "clean"
    elif args_ok(repair=True):
        verdict = "needs_repair"
    else:
        verdict = "wrong_args"
    return {"verdict": verdict, "channel": channel, "tool": tool, "args": args}


def cmd_tools(args) -> None:
    for arm, config in ARMS.items():
        rows = []
        for request, expected_tool, expected_args in TASKS:
            reply = chat(
                [{"role": "system", "content": config["system"]}, {"role": "user", "content": request}],
                max_tokens=150,
                **config["extra"],
            )
            message = reply.get("message", {})
            row = grade(message, expected_tool, expected_args)
            row.update(
                request=request,
                expected_tool=expected_tool,
                content=message.get("content", ""),
                structured=message.get("tool_calls"),
                usage=reply.get("usage"),
                error=reply.get("error"),
            )
            rows.append(row)
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
        save("tools", {"arm": arm, "counts": counts, "rows": rows})


# ---------------------------------------------------------------- context length

FILLER_LINE = "def handler_{n}(request): return render(request, 'page_{n}.html', {{'id': {n}}})\n"


def cmd_context(args) -> None:
    rows = []
    for lines in (20, 100, 200, 300, 500):
        filler = "".join(FILLER_LINE.format(n=n) for n in range(lines))
        prompt = (
            "The project codename is BLUEHERON.\n\nHere is a source file:\n\n"
            + filler
            + "\nWhat is the project codename? Answer with one word."
        )
        reply = chat([{"role": "user", "content": prompt}], max_tokens=10)
        used = reply.get("usage", {})
        rows.append(
            {
                "filler_lines": lines,
                "prompt_characters": len(prompt),
                "prompt_tokens_reported": used.get("prompt_tokens"),
                "model_seconds": used.get("model_seconds"),
                "answer": reply.get("message", {}).get("content"),
                "recalled": "BLUEHERON" in (reply.get("message", {}).get("content") or "").upper(),
                "error": reply.get("error"),
            }
        )
    save("context", {"rows": rows})


# ---------------------------------------------------------------- using a tool result

FOLLOWUP_SYSTEM = PROMPTED_SYSTEM.replace(
    "Tools:\n",
    "Tools:\n- final_answer(answer): Give the user the final answer once you know it.\n",
)

FOLLOWUPS = [
    {
        "label": "answer is in the tool result",
        "user": "What port does the server listen on?",
        "call": {"tool": "read_file", "args": {"path": "config.py"}},
        "result": "HOST = '0.0.0.0'\nPORT = 8080\nDEBUG = False\n",
        "expect_tool": "final_answer",
        "expect_text": "8080",
    },
    {
        "label": "tool result is an error",
        "user": "What port does the server listen on?",
        "call": {"tool": "read_file", "args": {"path": "config.py"}},
        "result": "ERROR: file not found: config.py",
        "expect_tool": ("search_files", "run_shell", "read_file"),
        "expect_text": "",
    },
    {
        "label": "answer needs a second step",
        "user": "Does the test suite pass?",
        "call": {"tool": "run_shell", "args": {"command": "ls"}},
        "result": "package.json\nsrc\ntests\n",
        "expect_tool": ("run_shell",),
        "expect_text": "test",
    },
]


def cmd_followup(args) -> None:
    rows = []
    for case in FOLLOWUPS:
        reply = chat(
            [
                {"role": "system", "content": FOLLOWUP_SYSTEM},
                {"role": "user", "content": case["user"]},
                {"role": "assistant", "content": json.dumps(case["call"])},
                {"role": "user", "content": "Tool result:\n" + case["result"]},
            ],
            max_tokens=150,
            response_format="json",
        )
        message = reply.get("message", {})
        tool, call_args, channel = extract_call(message)
        expected = case["expect_tool"] if isinstance(case["expect_tool"], tuple) else (case["expect_tool"],)
        rows.append(
            {
                "label": case["label"],
                "content": message.get("content", ""),
                "tool": tool,
                "channel": channel,
                "tool_as_expected": tool in expected,
                "text_as_expected": case["expect_text"].lower() in json.dumps(call_args).lower(),
                "usage": reply.get("usage"),
            }
        )
    save("followup", {"rows": rows})


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("billing-snapshot").set_defaults(run=cmd_billing_snapshot)
    wake = commands.add_parser("wake")
    wake.add_argument("--label", default="")
    wake.add_argument("--calls", type=int, default=1)
    wake.add_argument("--max-tokens", type=int, default=5)
    wake.add_argument("--gap", type=float, default=0)
    wake.set_defaults(run=cmd_wake)
    commands.add_parser("tools").set_defaults(run=cmd_tools)
    commands.add_parser("context").set_defaults(run=cmd_context)
    commands.add_parser("followup").set_defaults(run=cmd_followup)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
