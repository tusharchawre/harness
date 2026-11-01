import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, sendMessage, watchModel, type Chat, type Message, type ModelState, type Preset, type Settings } from "./api";
import { Composer } from "./Composer";
import { Icon } from "./icons";
import { useFollow } from "./follow";
import { Markdown } from "./Markdown";
import { onMenu, onOpenSettings, setModelMenu } from "./native";
import { isPane, SettingsModal, type Pane } from "./Settings";
import { Sidebar, WindowButtons } from "./Sidebar";
import { TitleBar } from "./TitleBar";

type Draft = { chatId: string; reasoning: string; content: string; status: string };

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
  const [retitled, setRetitled] = useState<string | null>(null); // chat whose generated title is washing in
  // Settings sheet: mounted while open or animating closed.
  const [sheet, setSheet] = useState<{ pane: Pane; closing: boolean; key: number } | null>(null);
  // Reopening while it animates closed mounts a fresh sheet instead of being swallowed.
  const showSettings = (pane: string) =>
    setSheet((s) => ({ pane: isPane(pane) ? pane : "general", closing: false, key: s && !s.closing ? s.key : Date.now() }));
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const { away, pin, jump } = useFollow(scrollRef, threadRef);
  const jumpNext = useRef(false); // opening a chat lands on its last message, no glide
  const freshChat = useRef<string | null>(null); // created by send(): nothing to fetch, the stream fills it
  const mainRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
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
    const offModel = watchModel(setModel, (c) => {
      setChats((cs) => cs.map((x) => (x.id === c.id ? c : x)));
      setRetitled(c.id);
      setTimeout(() => setRetitled((r) => (r === c.id ? null : r)), 1500);
    });
    return () => (offSettings(), offModel());
  }, []);

  useEffect(() => {
    jumpNext.current = true;
    if (chatId && chatId === freshChat.current) return void (freshChat.current = null);
    setError(null);
    if (chatId)
      api
        .chat(chatId)
        .then((c) => chatIdRef.current === chatId && (setMsgs(c.messages), c.preset && setPreset(c.preset)))
        .catch((e) => setError(e.message));
    else setMsgs([]);
  }, [chatId]);

  // The thread's bottom padding follows the composer's height, so a tall draft never covers the reply.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => mainRef.current?.style.setProperty("--composer-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (jumpNext.current) (jumpNext.current = false), jump();
  }, [msgs]);

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

  // `resend` is regenerate/retry: send that text again without touching the composer.
  async function send(resend?: string) {
    const text = (resend ?? input).trim();
    if (!text || draft) return;
    setError(null);
    if (resend === undefined) setInput("");
    let delivered = false; // the server saved the user message
    pin();
    let id = chatId;
    if (!id) {
      id = (await api.createChat(activePreset?.id ?? "")).id;
      freshChat.current = id;
      chatIdRef.current = id;
      setMsgs([]);
      setChatId(id);
    }
    const ac = new AbortController();
    abortRef.current = ac;
    setDraft({ chatId: id, reasoning: "", content: "", status: "sending" });
    // The user may open another chat mid-reply: only touch the thread while this chat is on screen.
    const here = () => chatIdRef.current === id;
    try {
      await sendMessage(id, text, thinking, (e) => {
        if (e.event === "user") (delivered = true), here() && setMsgs((m) => [...m, e.data]), refreshChats(); // new chat shows up right away
        else if (e.event === "status") setDraft((d) => d && { ...d, status: e.data.status });
        else if (e.event === "reasoning") setDraft((d) => d && { ...d, reasoning: d.reasoning + e.data.text });
        else if (e.event === "content") setDraft((d) => d && { ...d, content: d.content + e.data.text });
        else if (e.event === "done") here() && setMsgs((m) => [...m, e.data]);
        else if (e.event === "error") here() && setError(e.data.message);
      }, ac.signal);
    } catch (e) {
      if (!ac.signal.aborted) {
        if (here()) setError(e instanceof Error ? e.message : String(e));
        if (!delivered && resend === undefined) setInput((cur) => cur || text); // never lose what was typed
      }
      else api.chat(id).then((c) => here() && setMsgs(c.messages)); // keep the partial reply the server saved
    } finally {
      setDraft(null);
      abortRef.current = null;
      refreshChats();
    }
  }

  // Regenerate the last reply, or retry after an error: drop the last user message and everything
  // after it, then send it again.
  async function regenerate() {
    if (!chatId || draft) return;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== "user") i--;
    if (i < 0) return;
    const u = msgs[i];
    await api.truncate(chatId, u.id);
    setMsgs(msgs.slice(0, i));
    send(u.content);
  }

  function pickChat(id: string) {
    setChatId(id);
    inputRef.current?.focus();
  }

  // Esc stops a reply; typing anywhere outside a field goes to the composer.
  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e) => {
    if (sheet || e.defaultPrevented) return;
    const el = document.activeElement;
    const inField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    if (e.key === "Escape" && busy && (el === document.body || el === inputRef.current)) abortRef.current?.abort(); // not while a menu has focus
    else if (!inField && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) inputRef.current?.focus();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const lastId = msgs.at(-1)?.id;
  const canRetry = !!chatId && !busy && msgs.at(-1)?.role === "user";

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
        retitled={retitled}
        hidden={sidebarHidden}
        onPick={pickChat}
        onNew={newChat}
        onToggle={() => setSidebarHidden(true)}
        onRename={renameChat}
        onDelete={removeChat}
      />

      <main className="main" ref={mainRef}>
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

        <div className="scroll" ref={scrollRef}>
          <div className="thread" ref={threadRef}>
            {msgs.length === 0 && draft?.chatId !== chatId && <div className="empty">Local chat. Nothing leaves this Mac.</div>}
            {msgs.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="user-msg">
                  <div className="user-bubble">{m.content}</div>
                  <div className="actions"><CopyButton text={m.content} /></div>
                </div>
              ) : (
                <div key={m.id} className="reply">
                  <Markdown text={m.content} />
                  <div className={"meta-row" + (m.id === lastId ? " last" : "")}>
                    <span className="meta">{[m.model, m.tokens_per_sec != null && `${m.tokens_per_sec.toFixed(1)} tok/s`].filter(Boolean).join(" · ")}</span>
                    <div className="actions">
                      <CopyButton text={m.content} />
                      {m.id === lastId && (
                        <button className="icon-btn sm" aria-label="Regenerate" title="Regenerate" disabled={busy} onClick={regenerate}>
                          <Icon name="retry" size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ),
            )}
            {draft && draft.chatId === chatId && (
              <div className="reply">
                {draft.content ? <Markdown text={draft.content} streaming /> : <div className="meta shimmer">{draft.status === "loading" ? "Loading model…" : "Thinking…"}</div>}
              </div>
            )}
            {error && (
              <div className="banner error">
                {error}
                {canRetry && <button className="link-btn" onClick={regenerate}>Retry</button>}
              </div>
            )}
          </div>
        </div>

        <div className="composer-wrap" ref={composerRef}>
          {away && <button className="latest glass" onClick={pin}>↓ Latest</button>}
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
          key={sheet.key}
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

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button className="icon-btn sm" aria-label={done ? "Copied" : "Copy"} title={done ? "Copied" : "Copy"} onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}>
      <Icon name={done ? "check" : "copy"} size={13} />
    </button>
  );
}
