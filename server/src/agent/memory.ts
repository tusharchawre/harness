// Memory (Milestone 3): durable facts about the user, kept in SQLite and put into the system prompt
// of every chat. The model saves, updates and deletes them with tools; Settings › Memory lists them.
import { memories, type Memory } from "../db";
import type { Tool } from "./tools";

const MAX_FACT_CHARS = 400;
export const MEMORY_TOPICS = ["profile", "work", "vessify", "projects", "learning", "people", "family", "relationships", "health", "money", "music", "devices", "travel", "preferences", "other"] as const;
const CORE_BUDGET_CHARS = 2500; // pinned facts only; everything else is looked up with search_memory

export type MemoryChange = { action: "save" | "update" | "delete"; id: number; ids?: number[]; text: string; before?: string };

// What goes into every system prompt: the pinned core profile and a pointer to search_memory.
// Putting every memory in every prompt costs thousands of tokens per message once there are many.
export function memoryPrompt(): string {
  const all = memories.list();
  if (!all.length) return "You don't remember anything about the user yet. Use save_memory when they tell you something worth keeping.";
  const core: string[] = [];
  let used = 0;
  for (const m of all.filter((x) => x.pinned)) {
    const line = `[${m.id}] ${m.text}`;
    if (used + line.length > CORE_BUDGET_CHARS) break;
    core.push(line);
    used += line.length;
  }
  const rest = all.length - core.length;
  return [
    core.length ? `About the user (core memories; [id] for update_memory / delete_memory):\n${core.join("\n")}` : "",
    rest > 0
      ? `You also remember ${rest} more facts about the user (work, projects, people, family, health, money, music, plans, preferences). ` +
        `Before answering anything about their life that isn't above, call search_memory (keywords and/or a topic: ${MEMORY_TOPICS.join(", ")}). Don't recite memories unless asked.`
      : "",
  ].filter(Boolean).join("\n\n");
}

// Keyword search for now (M4 replaces it with embeddings): score = query words found in the fact,
// plural-tolerant prefix matches, ties broken by newest.
const STOP = new Set("the a an and or of to in on for with about my me i his he him is are was what who how when where do does did any all".split(" "));
const stem = (w: string) => (w.length > 3 ? w.replace(/(ies|es|s)$/, "") : w);
const terms = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}₹]+/u).filter((w) => w && !STOP.has(w)).map(stem);

export function searchMemories(query: string, topic?: string, limit = 15): Memory[] {
  const q = terms(query);
  const pool = memories.list().filter((m) => !topic || m.topic === topic);
  if (!q.length) return topic ? pool.slice(0, 40) : pool.slice(0, limit); // a whole topic, newest first
  return pool
    .map((m) => {
      const words = terms(`${m.topic ?? ""} ${m.text}`);
      // Prefix match either way ("deficien" ~ "deficiency"), but never on 1–2 letter words like "D".
      const score = q.reduce((n, t) => n + (words.some((w) => w.length > 2 && t.length > 2 && (w.startsWith(t) || t.startsWith(w))) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.id - a.m.id)
    .slice(0, limit)
    .map((x) => x.m);
}

export const searchMemory: Tool = {
  name: "search_memory",
  description:
    "Look up what you remember about the user: work, projects, people, family, health, money, music, plans, preferences. " +
    "Pass keywords (e.g. 'manager', 'Vibhor', 'Focus Protocol') and/or a topic to get everything on it (e.g. topic 'health'). " +
    "Returns matching facts with [id]. Search again with other words if the first try misses.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords or names; may be empty when a topic is given" },
      topic: { type: "string", enum: [...MEMORY_TOPICS], description: "Limit to one topic (alone: list the whole topic)" },
    },
  },
  async run(args) {
    const topic = MEMORY_TOPICS.includes(args.topic as never) ? String(args.topic) : undefined;
    const hits = searchMemories(String(args.query ?? ""), topic);
    if (!hits.length) return `No memories match${args.query ? ` "${args.query}"` : ""}${topic ? ` in ${topic}` : ""}. Try other words, or a topic alone.`;
    return hits.map((m) => `[${m.id}] (${m.topic ?? "other"}) ${m.text}`).join("\n");
  },
};

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
    properties: {
      facts: { type: "array", items: { type: "string" }, description: "Short facts, one idea each" },
      topic: { type: "string", enum: [...MEMORY_TOPICS], description: "Topic these facts belong to" },
    },
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
      const m = memories.add(fact, false, MEMORY_TOPICS.includes(args.topic as never) ? String(args.topic) : "other");
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
