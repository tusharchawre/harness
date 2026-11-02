// list_files and read_file. Access is set in Settings › Tools: off, one folder, or the whole Mac.
// Either way, files that usually hold secrets (SSH keys, cloud credentials, .env files, browser
// and Keychain data) are only read after the user says yes in the permission sheet.
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { DATA_DIR } from "../config";
import { settings } from "../db";
import type { Tool } from "./tools";

const MAX_LIST = 300;
const MAX_FILE_BYTES = 1_000_000;
const MAX_READ_CHARS = 12_000; // ~3k tokens per call; the model pages with start_line
// Not walked into when listing recursively (still listable by naming them directly).
const SKIP = new Set(["node_modules", ".venv", "__pycache__", "dist", "build", ".next", "target", "Library", "Applications", "System", "Volumes", "private", "dev", "cores"]);

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

// ---- secrets ----
const H = homedir();
const SECRET_DIRS = [
  ".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker", ".password-store", ".config/gcloud", ".config/gh", ".config/op",
  "Library/Keychains", "Library/Cookies", "Library/Safari", "Library/Mail", "Library/Messages", "Library/Accounts",
  "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox", "Library/Application Support/BraveSoftware",
  "Library/Application Support/Arc", "Library/Application Support/Microsoft Edge", "Library/Application Support/1Password",
].map((d) => join(H, d));
const SECRET_SYSTEM = ["/Library/Keychains", "/private/var/db", "/private/etc/master.passwd", "/private/etc/sudoers"];
const SECRET_FILE =
  /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.htpasswd|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|service[-_]?account.*\.json|.*\.(pem|key|p12|pfx|kdbx|keychain|keychain-db|jks|keystore|ovpn))$/i;

export function isSecret(real: string) {
  const under = (d: string) => real === d || real.startsWith(d + sep);
  return SECRET_FILE.test(basename(real)) || [...SECRET_DIRS, ...SECRET_SYSTEM, DATA_DIR].some(under);
}

// Resolves a path the model gave (relative, ~/…, or absolute) through symlinks and refuses
// anything outside the allowed root, so a link can't point out of a shared folder.
export function resolvePath(p: string): string {
  const { dir, base } = root();
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

export const listFiles: Tool = {
  name: "list_files",
  description:
    "List files and folders the user has shared, nearest first (folders end in /; hidden and build folders skipped; " +
    "private files are marked and need the user's OK to read). " +
    "Use it to find a file before read_file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Folder to list. Omit for the top of what's shared (the home folder when the whole Mac is shared)." } },
  },
  available: () => filesAccess() !== "off",
  async run(args, ctx) {
    const start = resolvePath(String(args.path ?? "."));
    if (!statSync(start).isDirectory()) throw new Error(`${shown(start)} is a file, not a folder; use read_file`);
    if (isSecret(start) && !(await ctx.ask({ tool: "list_files", path: start, action: "read" }))) throw new Error("the user declined to share that folder");
    // Breadth-first, so a big tree shows its top levels before the cap is hit.
    const out: string[] = [];
    const queue = [start];
    while (queue.length && out.length < MAX_LIST) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue; // no permission (macOS privacy folders) or vanished
      }
      for (const e of entries) {
        if (out.length >= MAX_LIST) break;
        if (e.name.startsWith(".") && e.isDirectory()) continue; // .git, .venv, …; dotfiles (.env) still show
        const full = join(dir, e.name);
        // Private entries are named (so the model can ask for them) but never walked into.
        const tag = isSecret(full) ? "  [private: reading asks the user first]" : "";
        if (e.isDirectory()) {
          out.push(`${shown(full)}/${tag}`);
          if (!tag && !SKIP.has(e.name)) queue.push(full);
        } else if (e.isFile()) out.push(`${shown(full)}  (${size(statSync(full, { throwIfNoEntry: false })?.size ?? 0)})${tag}`);
      }
    }
    if (!out.length) return "No files.";
    return out.join("\n") + (out.length >= MAX_LIST ? "\n[list cut at 300 entries; list a subfolder for more]" : "");
  },
};

export const readFile: Tool = {
  name: "read_file",
  description:
    "Read a text file the user has shared. Returns numbered lines; long files come in parts, " +
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
    const file = Bun.file(path);
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
    // Secrets don't become source chips: the sheet would show them again.
    return { text: `${shown(path)}\n${text}${rest}`, sources: secret ? [] : [{ path, title: basename(path) }] };
  },
};

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
