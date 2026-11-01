import { homedir } from "node:os";
import { resolve } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { config, DEFAULT_SYSTEM_PROMPT, presetById, presets, type ModelPreset } from "./config";
import { chats, memories, messages, settings, type Chat } from "./db";
import { OpenAICompatClient, QWEN_SAMPLING, type ChatMessage } from "./model/client";
import { ModelManager } from "./model/manager";

const manager = new ModelManager(Number(settings.get("idleMinutes") ?? config.defaultIdleMinutes));
const client = new OpenAICompatClient(manager.baseUrl);
// Max reasoning tokens before the model is made to answer. 0 = no cap.
let thinkingBudget = Number(settings.get("thinkingBudget") ?? config.defaultThinkingBudget);

// Chat changes made in the background (generated titles) go out on the /api/model/events stream.
const UNTITLED = "Untitled"; // until the model names the chat after its first reply
const chatListeners = new Set<(c: Chat) => void>();
const emitChat = (c: Chat | null) => c && chatListeners.forEach((fn) => fn(c));

// Fallback when the model can't name the chat: the first line of the message, cut at a word.
function quickTitle(text: string) {
  const line = text.trim().split("\n").find((l) => l.trim())?.replace(/^[#>*\-\s]+/, "").replace(/\s+/g, " ").trim() ?? "New chat";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return (cut.lastIndexOf(" ") > 24 ? cut.slice(0, cut.lastIndexOf(" ")) : cut) + "…";
}

// Like Claude on the web: after the first reply, the loaded model names the chat in a few words.
async function nameChat(chatId: string, placeholder: string, preset: ModelPreset, question: string, answer: string) {
  let out = "";
  try {
    await manager.use(async () => {
      const req = {
        model: preset.model,
        thinking: false,
        maxTokens: 24,
        sampling: { ...QWEN_SAMPLING.instruct, temperature: 0.3 },
        messages: [
          { role: "system" as const, content: "You name chats. Reply with only a title of 2 to 6 words saying what the conversation is about. Sentence case. No quotes, emoji or trailing punctuation." },
          { role: "user" as const, content: `User: ${question.slice(0, 1500)}\n\nAssistant: ${answer.slice(0, 600)}\n\nTitle:` },
        ],
      };
      for await (const ev of client.stream(req)) if (ev.type === "content") out += ev.text;
    });
  } catch {}
  const title = out
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n").map((l) => l.trim()).find(Boolean)
    ?.replace(/^title:\s*/i, "")
    .replace(/^["'“”‘’*#\s]+|["'“”‘’*.!\s]+$/g, "")
    .slice(0, 60);
  // Skip if the user renamed it meanwhile.
  if (chats.get(chatId)?.title !== placeholder) return;
  chats.rename(chatId, title || quickTitle(question));
  emitChat(chats.get(chatId));
}

const app = new Hono();
app.use("/api/*", cors({ origin: config.allowedOrigins }));
app.onError((e, c) => c.json({ error: e.message }, 500));

app.get("/api/health", (c) => c.json({ ok: true }));

// ---- model ----
app.get("/api/model", (c) => c.json(manager.state()));
app.get("/api/model/events", (c) =>
  streamSSE(c, async (stream) => {
    await stream.writeSSE({ event: "state", data: JSON.stringify(manager.state()) });
    const off = manager.subscribe((s) => void stream.writeSSE({ event: "state", data: JSON.stringify(s) }));
    const onChat = (ch: Chat) => void stream.writeSSE({ event: "chat", data: JSON.stringify(ch) });
    chatListeners.add(onChat);
    const done = () => void (off(), chatListeners.delete(onChat));
    stream.onAbort(done);
    while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    done();
  }),
);
app.get("/api/models", (c) => c.json(presets.map(({ id, label, model, draftModel, info }) => ({ id, label, model, mtp: !!draftModel, info: info ?? {} }))));
app.post("/api/model/load", async (c) => {
  const { preset } = await c.req.json<{ preset?: string }>().catch(() => ({ preset: undefined }));
  void manager.ensureReady(presetById(preset)).catch(() => {}); // progress arrives via /api/model/events
  return c.json(manager.state());
});
app.post("/api/model/unload", async (c) => {
  await manager.unload();
  return c.json(manager.state());
});

// ---- settings ----
// Everything here is saved in SQLite and applies to the next message.
const currentSettings = () => ({
  idleMinutes: manager.idleMinutes, // 0 = never unload
  thinkingBudget,
  thinkDefault: settings.get("thinkDefault") === "1",
  systemPrompt: settings.get("systemPrompt") ?? DEFAULT_SYSTEM_PROMPT,
  defaultModel: presetById(settings.get("defaultModel")).id,
});
app.get("/api/settings", (c) => c.json(currentSettings()));
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{
    idleMinutes?: number;
    thinkingBudget?: number;
    thinkDefault?: boolean;
    systemPrompt?: string;
    defaultModel?: string;
  }>();
  if (body.idleMinutes !== undefined && body.idleMinutes >= 0) {
    manager.idleMinutes = body.idleMinutes;
    settings.set("idleMinutes", String(body.idleMinutes));
  }
  if (body.thinkingBudget !== undefined && body.thinkingBudget >= 0) {
    thinkingBudget = Math.floor(body.thinkingBudget);
    settings.set("thinkingBudget", String(thinkingBudget));
  }
  if (body.thinkDefault !== undefined) settings.set("thinkDefault", body.thinkDefault ? "1" : "0");
  if (typeof body.systemPrompt === "string") settings.set("systemPrompt", body.systemPrompt);
  if (body.defaultModel) settings.set("defaultModel", presetById(body.defaultModel).id);
  return c.json(currentSettings());
});

// ---- chats ----
app.get("/api/chats", (c) => c.json(chats.list()));
app.post("/api/chats", async (c) => {
  const { preset } = await c.req.json<{ preset?: string }>().catch(() => ({ preset: undefined }));
  return c.json(chats.create(UNTITLED, presetById(preset).id));
});
app.patch("/api/chats/:id", async (c) => {
  const { preset, title } = await c.req.json<{ preset?: string; title?: string }>();
  if (preset) chats.setPreset(c.req.param("id"), presetById(preset).id); // takes effect on the next message
  if (title?.trim()) chats.rename(c.req.param("id"), title.trim().slice(0, 120));
  return c.json(chats.get(c.req.param("id")));
});
app.get("/api/chats/:id", (c) => {
  const chat = chats.get(c.req.param("id"));
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json({ ...chat, messages: messages.list(chat.id) });
});
// Drop a message and everything after it (regenerate / retry then send the user message again).
app.post("/api/chats/:id/truncate", async (c) => {
  const { from } = await c.req.json<{ from: number }>();
  if (!Number.isInteger(from)) return c.json({ error: "bad message id" }, 400);
  messages.deleteFrom(c.req.param("id"), from);
  return c.json({ ok: true });
});
app.delete("/api/chats/:id", (c) => {
  chats.delete(c.req.param("id"));
  return c.json({ ok: true });
});

// ---- files (source sheet) ----
// Text files under the home folder only, for previewing cited notes.
app.get("/api/file", async (c) => {
  const path = resolve(c.req.query("path")?.replace(/^~(?=\/)/, homedir()) ?? "");
  if (!path.startsWith(homedir() + "/") || !/\.(md|markdown|txt|mdx)$/i.test(path)) return c.json({ error: "not allowed" }, 403);
  const file = Bun.file(path);
  if (!(await file.exists())) return c.json({ error: "not found" }, 404);
  if (file.size > 2_000_000) return c.json({ error: "too large" }, 413);
  return c.json({ path, content: await file.text() });
});

// ---- memory ----
app.get("/api/memories", (c) => c.json(memories.list()));
app.post("/api/memories", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text?.trim()) return c.json({ error: "empty fact" }, 400);
  return c.json(memories.add(text.trim()));
});
app.delete("/api/memories/:id", (c) => {
  memories.delete(Number(c.req.param("id")));
  return c.json({ ok: true });
});

// Send a user message; the reply streams back as SSE:
// user → status* → (reasoning | content)* → done | error
app.post("/api/chats/:id/messages", async (c) => {
  const chat = chats.get(c.req.param("id"));
  if (!chat) return c.json({ error: "not found" }, 404);
  const { content, thinking = false } = await c.req.json<{ content: string; thinking?: boolean }>();
  if (!content?.trim()) return c.json({ error: "empty message" }, 400);

  const history = messages.list(chat.id);
  const userMsg = messages.add({
    chat_id: chat.id, role: "user", content, reasoning: null, model: null, thinking: null,
    prompt_tokens: null, completion_tokens: null, tokens_per_sec: null,
  });
  const placeholder = chat.title === UNTITLED ? UNTITLED : null; // also retries if an earlier first reply was stopped
  chats.touch(chat.id);

  // Only final answers go back into context; past reasoning is dropped.
  const system = currentSettings().systemPrompt.trim();
  const prompt: ChatMessage[] = [
    ...(system ? [{ role: "system" as const, content: system }] : []),
    ...[...history, userMsg].map((m) => ({ role: m.role, content: m.content })),
  ];

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    await send("user", userMsg);

    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    let text = "";
    let reasoning = "";
    let usage = { promptTokens: 0, completionTokens: 0 };
    let firstTokenAt = 0;
    let reasoningAt = 0; // first reasoning token
    let answerAt = 0; // first answer token
    const preset = presetById(chat.preset);
    const model = preset.label;
    try {
      const st = manager.state();
      if (st.status !== "ready" || st.presetId !== preset.id) await send("status", { status: "loading", model });
      await manager.ensureReady(preset);
      await send("status", { status: "generating", model });

      // mlx-vlm enforces the budget itself, but refuses it while a speculative drafter is loaded.
      const budget = thinking && thinkingBudget && !preset.draftModel ? thinkingBudget : undefined;
      let reasoningTokens = 0; // one token per streamed chunk
      await manager.use(async () => {
        const req = { model: preset.model, messages: prompt, thinking, thinkingBudget: budget, signal: abort.signal };
        for await (const ev of client.stream(req)) {
          if (ev.type === "usage") {
            usage = ev;
            continue;
          }
          firstTokenAt ||= performance.now();
          if (ev.type === "reasoning") (reasoningAt ||= performance.now()), (reasoning += ev.text), reasoningTokens++;
          else (answerAt ||= performance.now()), (text += ev.text);
          await send(ev.type, { text: ev.text });
        }
      });
      if (budget && reasoningTokens >= budget) reasoning += `\n\n[thinking budget of ${budget} tokens reached]`;
    } catch (e) {
      if (!abort.signal.aborted) await send("error", { message: e instanceof Error ? e.message : String(e) });
    }

    if (!text && !reasoning) return;
    // Decode speed: generated tokens over the time since the first token (excludes prompt processing).
    const secs = firstTokenAt ? (performance.now() - firstTokenAt) / 1000 : 0;
    const tps = usage.completionTokens > 1 && secs > 0 ? (usage.completionTokens - 1) / secs : null;
    const saved = messages.add({
      chat_id: chat.id, role: "assistant", content: text, reasoning: reasoning || null, model,
      thinking: thinking ? 1 : 0, prompt_tokens: usage.promptTokens || null,
      completion_tokens: usage.completionTokens || null, tokens_per_sec: tps,
      thinking_ms: reasoningAt ? Math.round((answerAt || performance.now()) - reasoningAt) : null,
    });
    chats.touch(chat.id);
    if (!abort.signal.aborted) await send("done", saved);
    if (placeholder && text) void nameChat(chat.id, placeholder, preset, content, text);
  });
});

// ---- lifecycle ----
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  manager.killNow();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => manager.killNow());

// As a Tauri sidecar: the app writes "shutdown" to stdin on quit. stdin can read as closed from
// the start under Tauri, so EOF isn't a quit signal; instead exit once the app's process is gone.
if (process.env.HARNESS_SIDECAR === "1") {
  (async () => {
    for await (const chunk of process.stdin) if (String(chunk).includes("shutdown")) shutdown();
  })().catch(() => {});
  const parent = Number(process.env.HARNESS_PARENT_PID);
  if (parent > 0)
    setInterval(() => {
      try {
        process.kill(parent, 0);
      } catch {
        shutdown();
      }
    }, 2000).unref();
}

Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
console.log(`[harness] http://127.0.0.1:${config.port}  presets=${presets.map((p) => p.id).join(",")}  db=${config.dbPath}`);
