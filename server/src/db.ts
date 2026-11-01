import { Database } from "bun:sqlite";
import { config } from "./config";

export const db = new Database(config.dbPath, { create: true });
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA foreign_keys = ON");
db.run(`CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`);
// Model preset per chat (added after the first schema; null = default preset).
if (!db.query<{ name: string }, []>("PRAGMA table_info(chats)").all().some((c) => c.name === "preset")) {
  db.run("ALTER TABLE chats ADD COLUMN preset TEXT");
}
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  model TEXT,
  thinking INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  tokens_per_sec REAL,
  created_at INTEGER NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id)");
// Added later: reasoning time, tool trace and cited sources (JSON) per reply.
for (const [col, type] of [["thinking_ms", "INTEGER"], ["tools", "TEXT"], ["sources", "TEXT"]]) {
  if (!db.query<{ name: string }, []>("PRAGMA table_info(messages)").all().some((c) => c.name === col)) {
    db.run(`ALTER TABLE messages ADD COLUMN ${col} ${type}`);
  }
}
db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
// Facts about the user (Settings › Memory). Used in chats from Milestone 3.
db.run("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created_at INTEGER NOT NULL)");

export type Chat = { id: string; title: string; preset: string | null; created_at: number; updated_at: number };
export type Message = {
  id: number;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  model: string | null;
  thinking: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tokens_per_sec: number | null;
  thinking_ms: number | null;
  tools: string | null; // JSON ToolStep[] (Milestone 2)
  sources: string | null; // JSON Source[] (Milestone 2)
  created_at: number;
};

export const chats = {
  list: () => db.query<Chat, []>("SELECT * FROM chats ORDER BY updated_at DESC").all(),
  get: (id: string) => db.query<Chat, [string]>("SELECT * FROM chats WHERE id = ?").get(id),
  create(title: string, preset: string | null): Chat {
    const now = Date.now();
    const chat = { id: crypto.randomUUID(), title, preset, created_at: now, updated_at: now };
    db.query("INSERT INTO chats (id, title, preset, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(chat.id, title, preset, now, now);
    return chat;
  },
  setPreset: (id: string, preset: string) => db.query("UPDATE chats SET preset = ? WHERE id = ?").run(preset, id),
  rename: (id: string, title: string) => db.query("UPDATE chats SET title = ? WHERE id = ?").run(title, id),
  touch: (id: string) => db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(Date.now(), id),
  delete: (id: string) => db.query("DELETE FROM chats WHERE id = ?").run(id),
};

export const messages = {
  deleteFrom: (chatId: string, fromId: number) => db.query("DELETE FROM messages WHERE chat_id = ? AND id >= ?").run(chatId, fromId),
  list: (chatId: string) =>
    db.query<Message, [string]>("SELECT * FROM messages WHERE chat_id = ? ORDER BY id").all(chatId),
  add(m: Omit<Message, "id" | "created_at" | "thinking_ms" | "tools" | "sources"> & Partial<Pick<Message, "thinking_ms" | "tools" | "sources">>): Message {
    return db
      .query<Message, any[]>(
        `INSERT INTO messages (chat_id, role, content, reasoning, model, thinking, prompt_tokens, completion_tokens, tokens_per_sec, thinking_ms, tools, sources, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(
        m.chat_id, m.role, m.content, m.reasoning, m.model, m.thinking, m.prompt_tokens, m.completion_tokens, m.tokens_per_sec,
        m.thinking_ms ?? null, m.tools ?? null, m.sources ?? null, Date.now(),
      )!;
  },
};

export type Memory = { id: number; text: string; created_at: number };
export const memories = {
  list: () => db.query<Memory, []>("SELECT * FROM memories ORDER BY id DESC").all(),
  add: (text: string) =>
    db.query<Memory, [string, number]>("INSERT INTO memories (text, created_at) VALUES (?, ?) RETURNING *").get(text, Date.now())!,
  delete: (id: number) => db.query("DELETE FROM memories WHERE id = ?").run(id),
};

export const settings = {
  get: (key: string) => db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key)?.value,
  set: (key: string, value: string) =>
    db.query("INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value),
};
