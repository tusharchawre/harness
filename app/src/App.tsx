import { useEffect, useRef, useState } from "react";
import { api, sendMessage, watchModel, type Chat, type Message, type ModelState, type Preset, type Settings } from "./api";
import { Composer } from "./Composer";
import { onMenu, onOpenSettings, setModelMenu } from "./native";
import { isPane, SettingsModal, type Pane } from "./Settings";
import { Sidebar, WindowButtons } from "./Sidebar";
import { TitleBar } from "./TitleBar";

type Draft = { reasoning: string; content: string; status: string };

export function App() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Message[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [model, setModel] = useState<ModelState | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  // Model for the open chat, or for the next new chat (starts at Settings › Model).
  const [preset, setPreset] = useState("");
  const [sidebarHidden, setSidebarHidden] = useState(false);
  // Settings sheet: mounted while open or animating closed.
  const [sheet, setSheet] = useState<{ pane: Pane; closing: boolean } | null>(null);
  const showSettings = (pane: string) => setSheet({ pane: isPane(pane) ? pane : "general", closing: false });
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshChats = () => api.chats().then(setChats);

  // New chats start from Settings › Model and Think by default.
  const applySettings = (s: Settings, resetDraftChat: boolean) => {
    setSettings(s);
    if (resetDraftChat) (setPreset(s.defaultModel), setThinking(s.thinkDefault));
  };
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;

  useEffect(() => {
    const boot = () =>
      Promise.all([refreshChats(), api.settings().then((s) => applySettings(s, true)), api.models().then(setPresets)])
        .then(() => setOffline(false))
        .catch(() => (setOffline(true), setTimeout(boot, 1500)));
    boot();
    const offSettings = onOpenSettings(showSettings);
    const offModel = watchModel(setModel);
    return () => (offSettings(), offModel());
  }, []);

  useEffect(() => {
    if (chatId)
      api.chat(chatId).then((c) => (setMsgs(c.messages), c.preset && setPreset(c.preset))).catch((e) => setError(e.message));
    else setMsgs([]);
  }, [chatId]);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: "end" }), [msgs, draft]);

  const activePreset = presets.find((p) => p.id === preset) ?? presets[0];
  const busy = draft !== null;

  // Keep the native Model menu in sync with the list, the selection and the load state.
  useEffect(() => {
    if (presets.length) setModelMenu(presets.map(({ id, label }) => ({ id, label })), activePreset?.id ?? null, model?.status === "ready");
  }, [presets, activePreset?.id, model?.status]);

  function choosePreset(id: string) {
    setPreset(id);
    if (chatId) api.setChatPreset(chatId, id).then(refreshChats);
  }

  function newChat() {
    setChatId(null);
    setError(null);
    if (settings) applySettings(settings, true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Menu bar / tray actions. Handlers read the latest state through this ref.
  const menuRef = useRef<(id: string) => void>(() => {});
  menuRef.current = (id) => {
    if (id === "settings") showSettings("general");
    else if (id === "new_chat") newChat();
    else if (id === "toggle_sidebar") setSidebarHidden((h) => !h);
    else if (id === "unload") api.unloadModel();
    else if (id.startsWith("model:") && !busy) choosePreset(id.slice(6));
  };
  useEffect(() => onMenu((id) => menuRef.current(id)), []);

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

  async function renameChat(id: string, title: string) {
    await api.renameChat(id, title);
    refreshChats();
  }

  async function removeChat(id: string) {
    await api.deleteChat(id);
    if (id === chatId) setChatId(null);
    refreshChats();
  }

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        chatId={chatId}
        hidden={sidebarHidden}
        onPick={setChatId}
        onNew={newChat}
        onToggle={() => setSidebarHidden(true)}
        onRename={renameChat}
        onDelete={removeChat}
      />

      <main className="main">
        <TitleBar
          presets={presets}
          active={activePreset}
          model={model}
          disabled={busy}
          onPick={choosePreset}
          leading={sidebarHidden && <WindowButtons onToggle={() => setSidebarHidden(false)} onNew={newChat} />}
        />
        {offline && <div className="banner">Waiting for the harness server on 127.0.0.1:8787…</div>}
        {model?.status === "error" && <div className="banner error">{model.error}</div>}

        <div className="scroll">
          <div className="thread">
            {msgs.length === 0 && !draft && <div className="empty">Local chat. Nothing leaves this Mac.</div>}
            {msgs.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="user-bubble">{m.content}</div>
              ) : (
                <div key={m.id} className="reply">
                  <div className="md" style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
                  <div className="meta">{[m.model, m.tokens_per_sec != null && `${m.tokens_per_sec.toFixed(1)} tok/s`].filter(Boolean).join(" · ")}</div>
                </div>
              ),
            )}
            {draft && (
              <div className="reply">
                {draft.content ? <div className="md" style={{ whiteSpace: "pre-wrap" }}>{draft.content}</div> : <div className="meta shimmer">{draft.status === "loading" ? "Loading model…" : "Thinking…"}</div>}
              </div>
            )}
            {error && <div className="banner error">{error}</div>}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="composer-wrap">
          <Composer
            ref={inputRef}
            value={input}
            onChange={setInput}
            thinking={thinking}
            onThinking={setThinking}
            busy={busy}
            onSend={send}
            onStop={() => abortRef.current?.abort()}
          />
        </div>
      </main>

      {sheet && (
        <SettingsModal
          pane={sheet.pane}
          closing={sheet.closing}
          onClose={() => setSheet((s) => s && { ...s, closing: true })}
          onClosed={() => setSheet(null)}
          onSaved={(s) => applySettings(s, chatIdRef.current === null)}
        />
      )}
    </div>
  );
}
