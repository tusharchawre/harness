// list_files and read_file. Access is set in Settings › Tools: off, one folder, or the whole Mac.
// Either way, files that usually hold secrets (SSH keys, cloud credentials, .env files, browser
// and Keychain data) are only read after the user says yes in the permission sheet.
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { settings } from "../db";
import { isSecret } from "./secrets";
import type { Tool } from "./tools";

const MAX_LIST = 200;
const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_CHARS = 12_000; // ~3k tokens per call; the model pages with start_line
// Not walked into when listing recursively (still listable by naming them directly).

export { isSecret };
const H = homedir();

export type FilesAccess = "off" | "folder" | "all";
export const filesAccess = (): FilesAccess => {
  const a = settings.get("filesAccess");
  if (a === "off" || a === "folder" || a === "all") return a === "folder" && !filesFolder() ? "off" : a;
  return filesFolder() ? "folder" : "off"; // before the setting existed, a folder meant "folder"
};
export const filesFolder = () => settings.get("filesFolder") || null;

// The folder paths are relative to, and everything must stay inside: "/" for the whole Mac.
function root(): { dir: string; base: string } {
  const access = filesAccess();
  if (access === "off") throw new Error("file access is off");
  if (access === "all") return { dir: "/", base: homedir() };
  const dir = realpathSync(filesFolder()!);
  return { dir, base: dir };
}

// Resolves a path the model gave (relative, ~/…, or absolute) through symlinks and refuses
// anything outside the allowed root, so a link can't point out of a shared folder.
export function resolvePath(p: string): string {
  const { dir, base } = root();
  // Small models sometimes send the path as a JSON array or quoted string: ["~/a.md"].
  p = p.trim().replace(/^\[\s*"(.*)"\s*\]$/, "$1").replace(/^"(.*)"$/, "$1");
  const target = resolve(base, p.replace(/^~(?=\/|$)/, H));
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    throw new Error(`not found: ${p}`);
  }
  if (dir !== "/" && real !== dir && !real.startsWith(dir + sep)) throw new Error("that path is outside the shared folder");
  return real;
}

const shown = (real: string) => (filesAccess() === "all" ? real.replace(H, "~") : relative(root().dir, real) || ".");

const PRIVATE_TAG = "  [private: reading asks the user first]";
const tagged = (real: string, line: string) => line + (isSecret(real) ? PRIVATE_TAG : "");

// One folder, like `ls`: folders first, then files. Fast at any size.
export const listFiles: Tool = {
  name: "list_files",
  description:
    "List one folder (not recursive): subfolders end in /, files show their size. Private files are marked and need the user's OK to read. " +
    "To find a file by name anywhere use find_files; to search inside files use grep_files.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Folder to list. Omit for the top of what's shared (the home folder when the whole Mac is shared)." } },
  },
  available: () => filesAccess() !== "off",
  async run(args, ctx) {
    const dir = resolvePath(String(args.path ?? "."));
    if (!statSync(dir).isDirectory()) throw new Error(`${shown(dir)} is a file, not a folder; use read_file`);
    if (isSecret(dir) && !(await ctx.ask({ tool: "list_files", path: dir, action: "read" }))) throw new Error("the user declined to share that folder");
    const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !(e.name.startsWith(".") && e.isDirectory()));
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => tagged(join(dir, e.name), `${e.name}/`));
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => tagged(join(dir, e.name), `${e.name}  (${size(statSync(join(dir, e.name), { throwIfNoEntry: false })?.size ?? 0)})`));
    const all = [...dirs.sort(), ...files.sort((x, y) => x.localeCompare(y))];
    if (!all.length) return `${shown(dir)} is empty.`;
    const more = all.length > MAX_LIST ? `\n[${all.length - MAX_LIST} more not shown]` : "";
    return `${shown(dir)}/\n${all.slice(0, MAX_LIST).join("\n")}${more}`;
  },
};

// Paths no search should return: dependency, build, cache and app-internal folders.
const NOISE = /\/(node_modules|\.git|\.venv|venv|__pycache__|\.next|dist|build|target|\.Trash|\.cache|Caches|DerivedData|Pods|vendor|\.gradle|\.npm|\.bun)\/|\.app\/Contents\//;
const hiddenDir = (p: string) => /\/\.[^/]+\//.test(p);

// By name, through Spotlight's index: whole-home searches in well under a second.
export const findFiles: Tool = {
  name: "find_files",
  description:
    "Find files and folders by name (case-insensitive, partial match), using the Mac's Spotlight index. Fast even across the whole Mac. " +
    "Returns paths, shallowest first. Use a distinctive word from the file name, e.g. resume, invoice, todo.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Part of the file name" },
      path: { type: "string", description: "Folder to search in. Omit for everything shared." },
    },
    required: ["name"],
  },
  available: () => filesAccess() !== "off",
  async run(args) {
    const name = String(args.name ?? "").trim();
    if (!name) throw new Error("name is empty");
    const dir = resolvePath(String(args.path ?? "."));
    const out = await run(["mdfind", "-name", name, "-onlyin", dir], 10_000);
    const inLibrary = dir.includes("/Library");
    const hits = out
      .split("\n")
      .filter(Boolean)
      .filter((p) => !NOISE.test(p) && (inLibrary || !p.includes(`${H}/Library/`)) && (!hiddenDir(p.slice(dir.length)) || isSecret(p)))
      .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    if (!hits.length) return `No files named like "${name}" in ${shown(dir)}. Try a shorter or different word, or grep_files to search inside files.`;
    const MAX = 50;
    return hits.slice(0, MAX).map((p) => tagged(p, shown(p))).join("\n") + (hits.length > MAX ? `\n[${hits.length - MAX} more; narrow the name or path]` : "");
  },
};

// Inside files: ripgrep if installed, else the system grep. Private files are never searched into.
const RG = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg"].find((p) => Bun.file(p).size > 0);
const MAX_MATCHES = 80;
const GREP_TIMEOUT_MS = 15_000;
const EXCLUDE_DIRS = ["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "dist", "build", "target", "Library", ".Trash", ".cache", "DerivedData", "Pods", "vendor", "Music", "Pictures", "Movies", "Applications", "nltk_data", "site-packages", "*.photoslibrary"];

export const grepFiles: Tool = {
  name: "grep_files",
  description:
    "Search inside text files for a word or phrase (like grep). Returns file:line: text for each match, a few per file. " +
    "Give a folder whenever you can (find_files can locate a project folder first): searching everything is slow and noisy. " +
    "For 'which projects use X', search manifest files, e.g. glob package.json with whole_word. Private files are skipped.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Text to look for. Plain text unless regex is true. Case-insensitive unless it has capitals." },
      path: { type: "string", description: "Folder (or file) to search. Omit for everything shared." },
      glob: { type: "string", description: "Only files whose name matches, e.g. *.md or *.ts" },
      regex: { type: "boolean", description: "Treat pattern as a regular expression" },
      whole_word: { type: "boolean", description: "Match whole words only (hono matches hono, not honor)" },
    },
    required: ["pattern"],
  },
  available: () => filesAccess() !== "off",
  async run(args) {
    const pattern = String(args.pattern ?? "");
    if (!pattern) throw new Error("pattern is empty");
    const where = resolvePath(String(args.path ?? "."));
    const glob = args.glob ? String(args.glob) : null;
    const smartCase = /[A-Z]/.test(pattern) ? [] : ["-i"];
    const cmd = RG
      ? [RG, "-n", "--with-filename", "--no-heading", "--color=never", "-m", "5", "-M", "300", "--max-columns-preview", "--max-filesize", "2M", ...smartCase,
         ...(args.regex ? [] : ["-F"]), ...(args.whole_word ? ["-w"] : []), ...EXCLUDE_DIRS.flatMap((d) => ["-g", `!${d}/`]), ...(glob ? ["-g", glob] : []), "-e", pattern, where]
      : ["/usr/bin/grep", "-rHInI", "-m", "5", ...smartCase, args.regex ? "-E" : "-F", ...(args.whole_word ? ["-w"] : []), ...EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`),
         "--exclude-dir=.*", ...(glob ? [`--include=${glob}`] : []), "-e", pattern, where];

    const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), p.kill()), GREP_TIMEOUT_MS);
    const lines: string[] = [];
    let hidden = 0;
    let cut = false;
    let buf = "";
    const decoder = new TextDecoder();
    outer: for await (const chunk of p.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const file = line.slice(0, line.indexOf(":"));
        if (isSecret(file)) {
          hidden++;
          continue;
        }
        lines.push(`${shown(file)}${line.slice(file.length, file.length + 300)}`);
        if (lines.length >= MAX_MATCHES) {
          cut = true;
          p.kill();
          break outer;
        }
      }
    }
    clearTimeout(timer);
    const notes = [
      cut && `[stopped at ${MAX_MATCHES} matches; narrow the path or pattern]`,
      timedOut && `[search stopped after ${GREP_TIMEOUT_MS / 1000} s; give a smaller folder]`,
      hidden && `[${hidden} matches in private files not shown]`,
    ].filter(Boolean);
    if (!lines.length) return [`No matches for "${pattern}" in ${shown(where)}.`, ...notes].join("\n");
    return [...lines, ...notes].join("\n");
  },
};

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a file the user has shared: text, code, Word (.docx/.doc), RTF, ODT or PDF. Returns numbered lines; long files come in parts, " +
    "so pass start_line to continue. Answer from the file's actual text and say which file you used.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path as list_files shows it (or absolute, or ~/…)" },
      start_line: { type: "number", description: "First line to return, 1-based. Default 1." },
    },
    required: ["path"],
  },
  available: () => filesAccess() !== "off",
  async run(args, ctx) {
    const path = resolvePath(String(args.path ?? ""));
    if (statSync(path).isDirectory()) throw new Error("that's a folder; use list_files");
    const secret = isSecret(path);
    if (secret) {
      if (!(await ctx.ask({ tool: "read_file", path, action: "read" }))) throw new Error("the user declined to share this file");
      ctx.secretRead ??= path;
    }
    const lines = (await fileText(path)).split("\n");
    const start = Math.max(1, Math.floor(Number(args.start_line) || 1));
    let text = "";
    let end = start - 1;
    // Always at least one line (cut if it alone is too long), so paging moves forward.
    while (end < lines.length && (end < start || text.length + lines[end].length < MAX_READ_CHARS)) text += `${++end}\t${lines[end - 1].slice(0, MAX_READ_CHARS)}\n`;
    const rest = end < lines.length ? `[lines ${start}–${end} of ${lines.length}; continue with start_line ${end + 1}]` : "";
    // Secrets don't become source chips: the sheet would show them again.
    return { text: `${shown(path)}\n${text}${rest}`, sources: secret ? [] : [{ path, title: basename(path) }] };
  },
};

// Word, RTF, ODT and PDF go through macOS's own converters; anything else must be plain text.
const DOCUMENT = /\.(docx?|rtf|rtfd|odt|wordml|webarchive)$/i;
const MAX_DOCUMENT_BYTES = 50_000_000;
async function fileText(path: string): Promise<string> {
  const file = Bun.file(path);
  const limit = DOCUMENT.test(path) || /\.pdf$/i.test(path) ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES;
  if (file.size > limit) throw new Error(`file is ${size(file.size)}; the limit is ${size(limit)}`);
  if (DOCUMENT.test(path)) return run(["textutil", "-convert", "txt", "-stdout", path]);
  if (/\.pdf$/i.test(path)) {
    // PDFKit through JavaScript for Automation: no extra install.
    const js = `ObjC.import("PDFKit"); const d = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(${JSON.stringify(path)})); d.isNil() ? "" : ObjC.unwrap(d.string)`;
    const text = await run(["osascript", "-l", "JavaScript", "-e", js]);
    if (!text.trim()) throw new Error("no text in this PDF (it may be scanned images)");
    return text;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("not a text file (supported: text, Word, RTF, ODT, PDF)");
  return new TextDecoder().decode(bytes);
}

async function run(cmd: string[], timeoutMs = 60_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`couldn't convert this file: ${err.trim().slice(0, 200)}`);
  return out;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
