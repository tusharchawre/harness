// list_files and read_file, limited to the one folder the user picks in Settings › Tools.
// Offered to the model only while a folder is set.
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { settings } from "../db";
import type { Tool } from "./tools";

const MAX_LIST = 300;
const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_CHARS = 12_000; // ~3k tokens per call; the model pages with start_line
const SKIP = new Set([".git", "node_modules", ".venv", "__pycache__", "dist", "build", ".next", "target"]);

export const filesFolder = () => settings.get("filesFolder") || null;

// Resolves a path the model gave (relative to the folder, or absolute) and refuses anything that
// ends up outside the folder, following symlinks so a link can't point out of it.
export function insideFolder(p: string): string {
  const root = filesFolder();
  if (!root) throw new Error("no files folder is set");
  const rootReal = realpathSync(root);
  const target = resolve(rootReal, p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`not found: ${p}`);
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error("that path is outside the shared folder");
  return real;
}

export const listFiles: Tool = {
  name: "list_files",
  description:
    "List files in the user's shared folder (recursive; hidden files and build folders skipped). " +
    "Paths are relative to that folder. Use it to find a file before read_file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Subfolder to list, relative to the shared folder. Omit for the whole folder." } },
  },
  available: () => !!filesFolder(),
  async run(args) {
    const root = insideFolder(".");
    const dir = insideFolder(String(args.path ?? "."));
    const out: string[] = [];
    let more = 0;
    const walk = async (d: string) => {
      for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) out.length < MAX_LIST ? out.push(`${relative(root, full)}  (${size(statSync(full).size)})`) : more++;
      }
    };
    await walk(dir);
    if (!out.length) return "No files.";
    return out.join("\n") + (more ? `\n[${more} more files not shown; list a subfolder]` : "");
  },
};

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a text file from the user's shared folder. Returns numbered lines; long files come in parts, " +
    "so pass start_line to continue. Answer from the file's actual text and say which file you used.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the shared folder (as list_files shows it)" },
      start_line: { type: "number", description: "First line to return, 1-based. Default 1." },
    },
    required: ["path"],
  },
  available: () => !!filesFolder(),
  async run(args) {
    const path = insideFolder(String(args.path ?? ""));
    const file = Bun.file(path);
    if (statSync(path).isDirectory()) throw new Error("that's a folder; use list_files");
    if (file.size > MAX_FILE_BYTES) throw new Error(`file is ${size(file.size)}; the limit is ${size(MAX_FILE_BYTES)}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.subarray(0, 8000).includes(0)) throw new Error("not a text file");

    const lines = new TextDecoder().decode(bytes).split("\n");
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    let text = "";
    let end = start - 1;
    // Always at least one line (cut if it alone is too long), so paging moves forward.
    while (end < lines.length && (end < start || text.length + lines[end].length < MAX_READ_CHARS)) text += `${++end}\t${lines[end - 1].slice(0, MAX_READ_CHARS)}\n`;
    const rest = end < lines.length ? `[lines ${start}–${end} of ${lines.length}; continue with start_line ${end + 1}]` : "";
    const name = relative(insideFolder("."), path);
    return { text: `${name}\n${text}${rest}`, sources: [{ path, title: name.split(sep).pop() }] };
  },
};

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
