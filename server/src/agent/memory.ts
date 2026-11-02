// Memory (Milestone 3): durable facts about the user, kept in SQLite and put into the system prompt
// of every chat. The model saves, updates and deletes them with tools; Settings › Memory lists them.
import { memories, type Memory } from "../db";
import type { Tool } from "./tools";

const MAX_FACT_CHARS = 300;
const PROMPT_BUDGET_CHARS = 4000; // ~1k tokens; newest first. Past this, M4 embeddings pick the relevant ones.

export type MemoryChange = { action: "save" | "update" | "delete"; id: number; ids?: number[]; text: string; before?: string };

// What goes into the system prompt. Ids let the model update or delete a specific fact.
export function memoryPrompt(): string {
  const all = memories.list();
  if (!all.length) return "You don't remember anything about the user yet. Use save_memory when they tell you something worth keeping.";
  const lines: string[] = [];
  let used = 0;
  for (const m of all) {
    const line = `[${m.id}] ${m.text}`;
    if (used + line.length > PROMPT_BUDGET_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  return `What you remember about the user (from earlier chats; [id] for update_memory / delete_memory). Use it naturally when relevant; don't recite it unless asked:\n${lines.join("\n")}`;
}

// Never keep secrets, even if asked: memories go into every prompt and show in Settings.
const SECRETISH = /(sk-[\w-]{10,}|tvly-[\w-]{10,}|gh[pousr]_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{16}|-----BEGIN|\b[A-Za-z0-9_\-]{32,}\b|\b(password|passwd|api[ _-]?key|secret|token|otp|pin)\b\s*(is|:|=))/i;
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function checkFact(raw: unknown): string {
  const fact = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!fact) throw new Error("fact is empty");
  if (fact.length > MAX_FACT_CHARS) throw new Error(`keep a memory under ${MAX_FACT_CHARS} characters: one short fact`);
  if (SECRETISH.test(fact)) throw new Error("that looks like a password, key or token; memories never store secrets");
  return fact;
}
const find = (id: unknown): Memory => {
  const m = memories.list().find((x) => x.id === Number(id));
  if (!m) throw new Error(`no memory with id ${id}`);
  return m;
};

export const saveMemory: Tool = {
  name: "save_memory",
  description:
    "Remember durable facts about the user for future chats: who they are, their work and projects, preferences, people, plans. " +
    "Use when they ask you to remember something or state a lasting fact about themselves. One fact per item, third person " +
    "(e.g. ['Works at PriceLabs as a backend engineer', 'Prefers short answers']). Not for one-off tasks, things already " +
    "remembered (use update_memory), or secrets.",
  parameters: {
    type: "object",
    properties: { facts: { type: "array", items: { type: "string" }, description: "Short facts, one idea each" } },
    required: ["facts"],
  },
  async run(args) {
    const list = Array.isArray(args.facts) ? args.facts : [args.facts ?? args.fact]; // tolerate a single "fact"
    const out: string[] = [];
    let change: MemoryChange | undefined;
    for (const raw of list) {
      const fact = checkFact(raw);
      const dup = memories.list().find((m) => norm(m.text) === norm(fact));
      if (dup) {
        out.push(`Already remembered as [${dup.id}].`);
        continue;
      }
      const m = memories.add(fact);
      out.push(`Saved as [${m.id}]: ${m.text}`);
      change = change ? { ...change, text: `${change.text}; ${m.text}`, ids: [...(change.ids ?? [change.id]), m.id] } : { action: "save", id: m.id, text: m.text };
    }
    return { text: out.join("\n"), memory: change };
  },
};

export const updateMemory: Tool = {
  name: "update_memory",
  description: "Change a remembered fact that is out of date or wrong (use its [id] from the memory list). Prefer this over saving a near-duplicate.",
  parameters: {
    type: "object",
    properties: { id: { type: "number" }, fact: { type: "string", description: "The corrected fact" } },
    required: ["id", "fact"],
  },
  async run(args) {
    const old = find(args.id);
    const fact = checkFact(args.fact);
    memories.update(old.id, fact);
    return { text: `Updated [${old.id}].`, memory: { action: "update", id: old.id, text: fact, before: old.text } };
  },
};

export const deleteMemory: Tool = {
  name: "delete_memory",
  description: "Forget a remembered fact (use its [id]), e.g. when the user says to forget it or it's no longer true.",
  parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  async run(args) {
    const old = find(args.id);
    memories.delete(old.id);
    return { text: `Deleted [${old.id}].`, memory: { action: "delete", id: old.id, text: old.text } };
  },
};
