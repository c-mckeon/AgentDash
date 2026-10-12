/**
 * Builds web/data/code.json, the data behind the site's Pseudocode tab: every
 * file in the repository, with the plain-language notes written for it in
 * pseudocode/*.txt.
 *
 *   node tools/build-pseudocode.ts            build, refusing if code has changed
 *   node tools/build-pseudocode.ts --accept   build after re-checking the notes
 *
 * Notes point at code by line number, so a file that changes can leave its
 * notes pointing at the wrong lines. Each file's fingerprint is remembered in
 * pseudocode/checked.json; a build stops when one differs, until the notes
 * have been looked at again and the build is rerun with --accept.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NOTES_DIR = join(ROOT, "pseudocode");
const CHECKED = join(NOTES_DIR, "checked.json");
const OUTPUT = join(ROOT, "web", "data", "code.json");
/** Written by this script, so left out of the view. */
const GENERATED = ["web/data/code.json", "pseudocode/checked.json"];
/** Notes written but not yet shown on the site. */
const DRAFTS = "pseudocode/drafts/";

interface Chunk {
  title: string;
  /** Inclusive line ranges, counted from 1. */
  ranges: [number, number][];
  text: string;
}

/** Two levels per file: a high-level explanation, and a function-by-function plan. */
interface Note {
  summary: string;
  chunks: Chunk[];
  /** Opens the detailed level: what the file needs and how its parts connect. */
  plan: string;
  detail: Chunk[];
}

const read = (path: string) => readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
const lineCount = (text: string) => text.replace(/\n$/, "").split("\n").length;

/**
 * The notes format:
 *   === path/to/file          starts a file; the lines after it are its summary
 *   @ 10-24, 30 | Title       starts a chunk covering those lines ("all" = whole file)
 *   ...                       the chunk's pseudocode, until the next @ or ===
 *   --- detail                switches the file to its detailed level: the lines
 *                             after it are the plan, and later chunks are detailed ones
 */
function parseNotes(lengths: Map<string, number>): Map<string, Note> {
  const notes = new Map<string, Note>();
  for (const name of readdirSync(NOTES_DIR).filter((file) => file.endsWith(".txt")).sort()) {
    let path = "";
    let note: Note | null = null;
    let chunk: Chunk | null = null;
    let detailed = false;
    for (const line of read(join(NOTES_DIR, name)).split("\n")) {
      if (line.startsWith("=== ")) {
        path = line.slice(4).trim();
        if (notes.has(path)) throw new Error(`${path} has notes twice`);
        if (!lengths.has(path)) throw new Error(`${name} has notes for ${path}, which is not in the repository`);
        note = { summary: "", chunks: [], plan: "", detail: [] };
        chunk = null;
        detailed = false;
        notes.set(path, note);
      } else if (note && line.trim() === "--- detail") {
        detailed = true;
        chunk = null;
      } else if (note && line.startsWith("@ ")) {
        const [where, ...title] = line.slice(2).split("|");
        const last = lengths.get(path)!;
        const ranges = where.split(",").map((part): [number, number] => {
          if (part.trim() === "all") return [1, last];
          const [from, to = from] = part.trim().split("-").map(Number);
          if (!(from >= 1 && to >= from && to <= last)) {
            throw new Error(`${path}: lines "${part.trim()}" are outside the file (1-${last})`);
          }
          return [from, to];
        });
        chunk = { title: title.join("|").trim(), ranges, text: "" };
        (detailed ? note.detail : note.chunks).push(chunk);
      } else if (chunk) chunk.text += `${line}\n`;
      else if (note && detailed) note.plan += `${line}\n`;
      else if (note) note.summary += `${line}\n`;
    }
  }
  for (const note of notes.values()) {
    note.summary = note.summary.trim();
    note.plan = note.plan.trim();
    for (const chunk of [...note.chunks, ...note.detail]) chunk.text = chunk.text.trim();
  }
  return notes;
}

// Tracked files plus new ones, minus anything .gitignore excludes (so never .env).
const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
  .split("\n")
  .filter((path) => path && !GENERATED.includes(path) && !path.startsWith(DRAFTS) && existsSync(join(ROOT, path)))
  .sort();
const texts = new Map(paths.map((path) => [path, read(join(ROOT, path))]));

// A second guard for a public site: stop if any value from .env appears anywhere.
if (existsSync(join(ROOT, ".env"))) {
  const secrets = read(join(ROOT, ".env"))
    .split("\n")
    .map((line) => line.split("=").slice(1).join("=").trim())
    .filter((value) => value.length >= 8 && !value.startsWith("http"));
  for (const [path, text] of texts) {
    if (secrets.some((secret) => text.includes(secret))) throw new Error(`${path} contains a value from .env`);
  }
}

const notes = parseNotes(new Map([...texts].map(([path, text]) => [path, lineCount(text)])));

const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);
// Only files that have notes can have notes pointing at the wrong lines.
const tracked = paths.filter((path) => notes.has(path));
const current = Object.fromEntries(tracked.map((path) => [path, fingerprint(texts.get(path)!)]));
const accepted: Record<string, string> = existsSync(CHECKED) ? JSON.parse(read(CHECKED)) : {};
const changed = tracked.filter((path) => accepted[path] !== current[path]);

if (process.argv.includes("--accept")) {
  writeFileSync(CHECKED, `${JSON.stringify(current, null, 1)}\n`);
} else if (changed.length) {
  console.error(`Changed since their pseudocode was last checked:\n  ${changed.join("\n  ")}`);
  console.error("Check the line numbers in pseudocode/*.txt for these files, then rerun with --accept.");
  process.exit(1);
}

// Files with no notes yet are still listed, with their code and no chunks.
const files = paths.map((path) => ({ path, text: texts.get(path)!, ...(notes.get(path) ?? { summary: "", chunks: [], plan: "", detail: [] }) }));
writeFileSync(OUTPUT, JSON.stringify({ files }));
console.log(`Wrote ${files.length} files to web/data/code.json, ${notes.size} with pseudocode`);
