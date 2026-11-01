import { useEffect, useRef, useState } from "react";
import { api, sendMessage, watchModel, type Chat, type Message, type ModelState, type Preset, type Settings } from "./api";

type Draft = { reasoning: string; content: string; status: string };

export function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(() => localStorage.getItem("thinking") === "1");
  const [model, setModel] = useState<ModelState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  // Model for the open chat, or for the next new chat (remembers the last pick).
  const [preset, setPreset] = useState(() => localStorage.getItem("preset") ?? "");
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshChats = () => api.chats().then(setChats);

  useEffect(() => {
    const boot = () =>
      Promise.all([refreshChats(), api.settings().then(setSettings), api.models().then(setPresets)])
        .then(() => setOffline(false))
        .catch(() => (setOffline(true), setTimeout(boot, 1500)));
    boot();
    return watchModel(setModel);
  }, []);

  useEffect(() => {
    if (chatId)
      api.chat(chatId).then((c) => (setMsgs(c.messages), c.preset && setPreset(c.preset))).catch((e) => setError(e.message));
    else setMsgs([]);
  }, [chatId]);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [msgs, draft]);
  useEffect(() => localStorage.setItem("thinking", thinking ? "1" : "0"), [thinking]);

  const activePreset = presets.find((p) => p.id === preset) ?? presets[0];

  function choosePreset(id: string) {
    setPreset(id);
    localStorage.setItem("preset", id);
    if (chatId) api.setChatPreset(chatId, id).then(refreshChats);
  }

  async function send() {
    const text = input.trim();
    if (!text || draft) return;
    setError(null);
    setInput("");
    let id = chatId;
    if (!id) {
      id = (await api.createChat(activePreset?.id ?? "")).id;
      setChatId(id);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setDraft({ reasoning: "", content: "", status: "sending" });
    try {
      await sendMessage(id, text, thinking, (e) => {
        if (e.event === "user") setMsgs((m) => [...m, e.data]);
        else if (e.event === "status") setDraft((d) => d && { ...d, status: e.data.status });
        else if (e.event === "reasoning") setDraft((d) => d && { ...d, reasoning: d.reasoning + e.data.text });
        else if (e.event === "content") setDraft((d) => d && { ...d, content: d.content + e.data.text });
        else if (e.event === "done") setMsgs((m) => [...m, e.data]);
        else if (e.event === "error") setError(e.data.message);
      }, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : String(e));
      else if (id) api.chat(id).then((c) => setMsgs(c.messages)); // keep the partial reply the server saved
    } finally {
      setDraft(null);
      abortRef.current = null;
      refreshChats();
    }
  }

  async function removeChat(id: string) {
    await api.deleteChat(id);
    if (id === chatId) setChatId(null);
    refreshChats();
  }

  const busy = draft !== null;

  return (
    <div className="app">
      <aside className="sidebar">
        <button className="new" onClick={() => setChatId(null)}>+ New chat</button>
        <nav>
          {chats.map((c) => (
            <div key={c.id} className={"chat-item" + (c.id === chatId ? " active" : "")} onClick={() => setChatId(c.id)}>
              <span>{c.title}</span>
              <button className="x" title="Delete chat" onClick={(e) => (e.stopPropagation(), removeChat(c.id))}>×</button>
            </div>
          ))}
        </nav>
      </aside>

      <main>
        <header>
          <ModelPill state={model} />
          <div className="spacer" />
          {model?.status === "ready" && <button onClick={() => api.unloadModel()}>Unload now</button>}
          {(model?.status === "unloaded" || model?.status === "error") && activePreset && (
            <button onClick={() => api.loadModel(activePreset.id)}>Load</button>
          )}
          <button onClick={() => setShowSettings((s) => !s)}>Settings</button>
        </header>

        {showSettings && settings && <SettingsPanel settings={settings} onSave={(s) => api.saveSettings(s).then(setSettings)} />}
        {offline && <div className="banner">Waiting for the harness server on 127.0.0.1:8787…</div>}
        {model?.status === "error" && <div className="banner error">{model.error}</div>}

        <section className="messages">
          {msgs.length === 0 && !draft && <div className="empty">Local chat. Nothing leaves this Mac.</div>}
          {msgs.map((m) => <Bubble key={m.id} m={m} />)}
          {draft && (
            <div className="msg assistant">
              {draft.reasoning && <Reasoning text={draft.reasoning} open />}
              {draft.content ? <div className="content">{draft.content}</div> : <div className="meta">{statusLabel(draft.status, model)}</div>}
            </div>
          )}
          {error && <div className="banner error">{error}</div>}
          <div ref={bottomRef} />
        </section>

        <footer className="composer">
          <textarea
            value={input}
            placeholder="Message"
            rows={Math.min(8, input.split("\n").length)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), send());
            }}
          />
          <select
            className="model-select"
            title="Model for this chat (switching swaps the loaded model on the next message)"
            value={activePreset?.id ?? ""}
            disabled={busy}
            onChange={(e) => choosePreset(e.target.value)}
          >
            {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <label className="toggle" title="Qwen thinking mode (enable_thinking)">
            <input type="checkbox" checked={thinking} onChange={(e) => setThinking(e.target.checked)} /> Thinking
          </label>
          {busy ? <button onClick={() => abortRef.current?.abort()}>Stop</button> : <button className="primary" onClick={send} disabled={!input.trim()}>Send</button>}
        </footer>
      </main>
    </div>
  );
}

function statusLabel(status: string, model: ModelState | null) {
  if (status === "loading" || model?.status === "loading") return "Loading model… (switching models takes ~10–30 s)";
  if (status === "generating") return "Thinking…";
  return "…";
}

function ModelPill({ state }: { state: ModelState | null }) {
  const status = state?.status ?? "unloaded";
  return (
    <div className={`pill ${status}`}>
      <span className="dot" />
      {status}
      <span className="model-name">{state?.label}</span>
    </div>
  );
}

function Bubble({ m }: { m: Message }) {
  return (
    <div className={`msg ${m.role}`}>
      {m.reasoning && <Reasoning text={m.reasoning} />}
      <div className="content">{m.content}</div>
      {m.role === "assistant" && (
        <div className="meta">
          {m.model}
          {m.completion_tokens != null && ` · ${m.completion_tokens} tok`}
          {m.tokens_per_sec != null && ` · ${m.tokens_per_sec.toFixed(1)} tok/s`}
          {m.thinking ? " · thinking" : ""}
        </div>
      )}
    </div>
  );
}

function Reasoning({ text, open }: { text: string; open?: boolean }) {
  return (
    <details className="reasoning" open={open}>
      <summary>Reasoning</summary>
      <div>{text.trim()}</div>
    </details>
  );
}

function SettingsPanel({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [idle, setIdle] = useState(String(settings.idleMinutes));
  const [budget, setBudget] = useState(String(settings.thinkingBudget));
  return (
    <form className="settings" onSubmit={(e) => (e.preventDefault(), onSave({ idleMinutes: Number(idle), thinkingBudget: Number(budget) }))}>
      <label>
        Unload after idle (min) <input type="number" min={1} value={idle} onChange={(e) => setIdle(e.target.value)} />
      </label>
      <label title="Max reasoning tokens before the model must answer. 0 = no cap.">
        Thinking budget (tokens) <input type="number" min={0} step={256} value={budget} onChange={(e) => setBudget(e.target.value)} />
      </label>
      <button type="submit">Save</button>
      <small>The thinking budget isn't applied to MTP models yet (mlx-vlm doesn't support it with speculative decoding).</small>
    </form>
  );
}
