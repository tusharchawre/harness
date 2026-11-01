import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { config, presetById, presets } from "./config";
import { chats, messages, settings } from "./db";
import { OpenAICompatClient, type ChatMessage } from "./model/client";
import { ModelManager } from "./model/manager";

const manager = new ModelManager(Number(settings.get("idleMinutes") ?? config.defaultIdleMinutes));
const client = new OpenAICompatClient(manager.baseUrl);
// Max reasoning tokens before the model is made to answer. 0 = no cap.
let thinkingBudget = Number(settings.get("thinkingBudget") ?? config.defaultThinkingBudget);

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
    stream.onAbort(off);
    while (!stream.aborted) await stream.sleep(15_000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    off();
  }),
);
app.get("/api/models", (c) => c.json(presets.map(({ id, label, model, draftModel }) => ({ id, label, model, mtp: !!draftModel }))));
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
const currentSettings = () => ({ idleMinutes: manager.idleMinutes, thinkingBudget });
app.get("/api/settings", (c) => c.json(currentSettings()));
app.put("/api/settings", async (c) => {
  const body = await c.req.json<{ idleMinutes?: number; thinkingBudget?: number }>();
  if (body.idleMinutes && body.idleMinutes > 0) {
    manager.idleMinutes = body.idleMinutes;
    settings.set("idleMinutes", String(body.idleMinutes));
  }
  if (body.thinkingBudget !== undefined && body.thinkingBudget >= 0) {
    thinkingBudget = Math.floor(body.thinkingBudget);
    settings.set("thinkingBudget", String(thinkingBudget));
  }
  return c.json(currentSettings());
});

// ---- chats ----
app.get("/api/chats", (c) => c.json(chats.list()));
app.post("/api/chats", async (c) => {
  const { preset } = await c.req.json<{ preset?: string }>().catch(() => ({ preset: undefined }));
  return c.json(chats.create("New chat", presetById(preset).id));
});
app.patch("/api/chats/:id", async (c) => {
  const { preset } = await c.req.json<{ preset: string }>();
  chats.setPreset(c.req.param("id"), presetById(preset).id); // takes effect on the next message
  return c.json(chats.get(c.req.param("id")));
});
app.get("/api/chats/:id", (c) => {
  const chat = chats.get(c.req.param("id"));
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json({ ...chat, messages: messages.list(chat.id) });
});
app.delete("/api/chats/:id", (c) => {
  chats.delete(c.req.param("id"));
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
  if (history.length === 0) chats.rename(chat.id, content.trim().replace(/\s+/g, " ").slice(0, 60));
  chats.touch(chat.id);

  // Only final answers go back into context; past reasoning is dropped.
  const prompt: ChatMessage[] = [...history, userMsg].map((m) => ({ role: m.role, content: m.content }));

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) });
    await send("user", userMsg);

    const abort = new AbortController();
    stream.onAbort(() => abort.abort());

    let text = "";
    let reasoning = "";
    let usage = { promptTokens: 0, completionTokens: 0 };
    let firstTokenAt = 0;
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
          if (ev.type === "reasoning") reasoning += ev.text, reasoningTokens++;
          else text += ev.text;
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
    });
    chats.touch(chat.id);
    if (!abort.signal.aborted) await send("done", saved);
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

// As a Tauri sidecar, stdin is a pipe from the app: "shutdown" or EOF means the app is closing.
if (process.env.HARNESS_SIDECAR === "1") {
  (async () => {
    for await (const chunk of process.stdin) if (String(chunk).includes("shutdown")) shutdown();
    shutdown();
  })();
}

Bun.serve({ port: config.port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 0 });
console.log(`[harness] http://127.0.0.1:${config.port}  presets=${presets.map((p) => p.id).join(",")}  db=${config.dbPath}`);
