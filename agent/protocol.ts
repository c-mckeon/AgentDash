/**
 * How the agent and the model talk: the tools on offer, the instructions, and
 * a tolerant reader for the model's replies.
 *
 * Research (2026-10-12) found this model ignores Ollama's built-in tool
 * channel, so tools are described in our own prompt and the reply is forced
 * to be JSON. The reader still repairs the shape mistakes that were observed.
 */

export interface ToolSpec {
  description: string;
  args: Record<string, string>;
}

export const TOOLS: Record<string, ToolSpec> = {
  read_file: { description: "Read a file and return its contents.", args: { path: "Path relative to the repo root" } },
  write_file: {
    description: "Create a new file, or replace a whole file, with the full text given.",
    args: { path: "Path relative to the repo root", content: "Full text of the file" },
  },
  // Added after the first agent runs: asked to add a line, the model rewrote
  // the whole file with only that line. These let it change part of a file
  // without having to reproduce the rest.
  append_file: {
    description: "Add text to the end of an existing file. The rest of the file is kept.",
    args: { path: "Path relative to the repo root", content: "Text to add at the end" },
  },
  replace_in_file: {
    description: "Replace one exact piece of text in a file. The rest of the file is kept.",
    args: { path: "Path relative to the repo root", find: "Exact text to replace", replace: "New text" },
  },
  search_files: { description: "Search all files for a text pattern.", args: { pattern: "Text to search for" } },
  run_shell: { description: "Run a shell command in the repo root.", args: { command: "The command line to run" } },
  finish: { description: "Call this once the task is complete.", args: { summary: "One sentence on what you did" } },
};

export interface ToolCall {
  tool: string;
  args: Record<string, string>;
}

/** Forces the reply to be {"tool": <known tool>, "args": {...}}. */
export const REPLY_SCHEMA = {
  type: "object",
  properties: { tool: { type: "string", enum: Object.keys(TOOLS) }, args: { type: "object" } },
  required: ["tool", "args"],
};

export function systemPrompt(): string {
  const tools = Object.entries(TOOLS)
    .map(([name, spec]) => `- ${name}(${Object.keys(spec.args).join(", ")}): ${spec.description}`)
    .join("\n");
  return [
    "You are a coding agent working in a code repository. You act only by calling tools, one per reply.",
    "After each call you are shown its result. Look at files before changing them. When the task is done, call finish.",
    `\nTools:\n${tools}`,
    '\nReply with exactly one JSON object and nothing else, in this form:\n{"tool": "<tool name>", "args": {"<argument>": "<value>"}}',
    '\nExample: {"tool": "read_file", "args": {"path": "src/app.py"}}',
  ].join("\n");
}

/** The first balanced {...} in the text that parses as JSON, else null. */
function firstJsonObject(text: string): unknown {
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Repairs the schema-echo mistake: {"type": "string", "value": "x"} → "x". */
function plainValue(value: unknown): unknown {
  return isObject(value) && "value" in value ? value.value : value;
}

export function parseReply(text: string): { call: ToolCall } | { error: string } {
  let found: unknown = null;
  try {
    found = JSON.parse(text.trim());
  } catch {
    found = firstJsonObject(text);
  }
  if (!isObject(found)) return { error: "the reply contained no JSON object" };

  const tool = found.tool ?? found.name;
  if (typeof tool !== "string" || !(tool in TOOLS)) {
    return { error: `unknown tool ${JSON.stringify(tool)}; the tools are ${Object.keys(TOOLS).join(", ")}` };
  }

  // Arguments are sometimes nested under another name, or left at the top level.
  const nested = [found.args, found.arguments, found.parameters].find(isObject);
  const source = nested && Object.keys(nested).length ? nested : found;
  const args: Record<string, string> = {};
  for (const name of Object.keys(TOOLS[tool].args)) {
    const value = plainValue(source[name]);
    if (typeof value === "number" || typeof value === "boolean") args[name] = String(value);
    else if (typeof value === "string") args[name] = value;
    else return { error: `${tool} needs the argument "${name}" as a string` };
  }
  return { call: { tool, args } };
}
