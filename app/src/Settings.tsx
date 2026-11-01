import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Memory, type Preset, type Settings } from "./api";
import { Icon, type IconName } from "./icons";
import { announceSettings, onSettingsPane } from "./native";

type Pane = "general" | "models" | "tools" | "memory" | "voice";
const PANES: { id: Pane; label: string; icon: IconName; keywords: string }[] = [
  { id: "general", label: "General", icon: "general", keywords: "model idle unload think budget system prompt memory" },
  { id: "models", label: "Models", icon: "models", keywords: "model size speed humaneval qwen mtp" },
  { id: "tools", label: "Tools", icon: "tools", keywords: "tools permissions files write" },
  { id: "memory", label: "Memory", icon: "memory", keywords: "memory facts" },
  { id: "voice", label: "Voice", icon: "voice", keywords: "voice mic speech" },
];
const IDLE_OPTIONS = [
  { value: 10, label: "After 10 minutes" },
  { value: 30, label: "After 30 minutes" },
  { value: 60, label: "After 1 hour" },
  { value: 0, label: "Never" },
];

function initialPane(): Pane {
  try {
    const p = localStorage.getItem("settings-pane") as Pane | null;
    if (p && PANES.some((x) => x.id === p)) return p;
  } catch {}
  return "general";
}

export function SettingsWindow() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [offline, setOffline] = useState(false);
  const [q, setQ] = useState("");
  // Back/forward like System Settings: a history of panes and a cursor.
  const [nav, setNav] = useState<{ stack: Pane[]; at: number }>(() => ({ stack: [initialPane()], at: 0 }));
  const pane = nav.stack[nav.at];

  const go = (p: Pane) => setNav((n) => (n.stack[n.at] === p ? n : { stack: [...n.stack.slice(0, n.at + 1), p], at: n.at + 1 }));

  useEffect(() => {
    const boot = () =>
      Promise.all([api.settings().then(setSettings), api.models().then(setPresets), api.memories().then(setMemories)])
        .then(() => setOffline(false))
        .catch(() => (setOffline(true), setTimeout(boot, 1500)));
    boot();
    return onSettingsPane((p) => PANES.some((x) => x.id === p) && go(p as Pane));
  }, []);

  // Every change saves straight away and tells the main window.
  const save = (patch: Partial<Settings>) => {
    setSettings((s) => s && { ...s, ...patch });
    api.saveSettings(patch).then((s) => (setSettings((cur) => (cur ? { ...s, systemPrompt: cur.systemPrompt } : s)), announceSettings()));
  };

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? PANES.filter((p) => (p.label + " " + p.keywords).toLowerCase().includes(needle)) : PANES;
  }, [q]);

  const title = PANES.find((p) => p.id === pane)!.label;
  const s = settings;

  return (
    <div className="app settings-window">
      <nav className="settings-nav glass" aria-label="Settings sections">
        <div className="nav-head" data-tauri-drag-region />
        <label className="search">
          <Icon name="search" size={13} stroke={2.2} />
          <input aria-label="Search settings" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {visible.map((p) => (
          <button key={p.id} className={"nav-item" + (p.id === pane ? " current" : "")} aria-current={p.id === pane ? "page" : undefined} onClick={() => go(p.id)}>
            <Icon name={p.icon} size={15} />
            {p.label}
          </button>
        ))}
      </nav>

      <main className="settings-main">
        <div className="settings-toolbar" data-tauri-drag-region>
          <div className="history">
            <button className="icon-btn" aria-label="Back" disabled={nav.at === 0} onClick={() => setNav((n) => ({ ...n, at: n.at - 1 }))}>
              <Icon name="chevronLeft" size={12} stroke={2.8} />
            </button>
            <button className="icon-btn" aria-label="Forward" disabled={nav.at === nav.stack.length - 1} onClick={() => setNav((n) => ({ ...n, at: n.at + 1 }))}>
              <Icon name="chevronRight" size={12} stroke={2.8} />
            </button>
          </div>
          <h1 data-tauri-drag-region>{title}</h1>
        </div>

        <div className="settings-scroll">
          <div className="settings-content">
            {offline && <div className="banner">Waiting for the harness server on 127.0.0.1:8787…</div>}
            {s && (
              <>
                {(pane === "general" || pane === "models") && <ModelGroup s={s} presets={presets} save={save} />}
                {pane === "models" && <ModelList presets={presets} current={s.defaultModel} />}
                {pane === "general" && <RuntimeGroup s={s} presets={presets} save={save} />}
                {pane === "general" && <SystemPrompt value={s.systemPrompt} save={save} />}
                {(pane === "general" || pane === "memory") && <MemoryList memories={memories} setMemories={setMemories} />}
                {pane === "tools" && <Placeholder>Tools arrive in Milestone 2. Anything that writes or deletes files will ask first.</Placeholder>}
                {pane === "voice" && <Placeholder>Voice input arrives with the voice milestone.</Placeholder>}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Popup<T extends string | number>(props: { id: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="popup">
      <select
        id={props.id}
        value={String(props.value)}
        onChange={(e) => {
          const hit = props.options.find((o) => String(o.value) === e.target.value);
          if (hit) props.onChange(hit.value);
        }}
      >
        {props.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      <svg width="9" height="12" viewBox="0 0 9 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M1.5 4.5L4.5 1.5 7.5 4.5M1.5 7.5L4.5 10.5 7.5 7.5" />
      </svg>
    </span>
  );
}

// WebKit's native switch control (drawn by the system, follows the accent color).
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return <input type="checkbox" {...{ switch: "" }} aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} />;
}

function ModelGroup({ s, presets, save }: { s: Settings; presets: Preset[]; save: (p: Partial<Settings>) => void }) {
  const p = presets.find((x) => x.id === s.defaultModel) ?? presets[0];
  return (
    <section className="group" aria-label="Model">
      <div className="row">
        <label htmlFor="model" className="grow">
          Model
          <div className="sub">Used for new chats. Each chat can switch from the title bar.</div>
        </label>
        <Popup id="model" value={s.defaultModel} options={presets.map((x) => ({ value: x.id, label: x.label }))} onChange={(v) => save({ defaultModel: v })} />
      </div>
      <div className="info"><span>Size in memory</span><span>{p?.info.size ?? "—"}</span></div>
      <div className="info"><span>Speed</span><span>{p?.info.speed ?? "—"}</span></div>
      <div className="info"><span>HumanEval · fresh</span><span>{p?.info.humaneval ?? "—"}</span></div>
    </section>
  );
}

function ModelList({ presets, current }: { presets: Preset[]; current: string }) {
  return (
    <section className="block" aria-label="Installed models">
      <div className="caption">Available models</div>
      <div className="group">
        {presets.map((p) => (
          <div key={p.id} className="info">
            <span style={{ color: "var(--text)" }}>
              {p.label} {p.id === current && <span style={{ color: "var(--muted)" }}>· default</span>}
            </span>
            <span className="mono">{p.model}</span>
          </div>
        ))}
      </div>
      <div className="footnote">Add models with a models.json in ~/Library/Application Support/harness.</div>
    </section>
  );
}

function RuntimeGroup({ s, presets, save }: { s: Settings; presets: Preset[]; save: (p: Partial<Settings>) => void }) {
  const p = presets.find((x) => x.id === s.defaultModel) ?? presets[0];
  const size = p?.info.size?.replace(" · 4-bit", "");
  const idle = IDLE_OPTIONS.some((o) => o.value === s.idleMinutes) ? IDLE_OPTIONS : [...IDLE_OPTIONS, { value: s.idleMinutes, label: `After ${s.idleMinutes} minutes` }];
  const max = 4096;
  const budget = Math.min(s.thinkingBudget, max);
  return (
    <section className="group" aria-label="Runtime">
      <div className="row">
        <div className="grow">
          <label htmlFor="idle">Unload model when idle</label>
          <div className="sub">{size ? `Frees ${size.startsWith("~") ? size : "~" + size}. ` : ""}Reloading takes ~10–30 s.</div>
        </div>
        <Popup id="idle" value={s.idleMinutes} options={idle} onChange={(v) => save({ idleMinutes: v })} />
      </div>
      <div className="row">
        <div className="grow">
          <div>Think by default</div>
          <div className="sub">Off keeps replies fast. Turn it on per message.</div>
        </div>
        <Switch on={s.thinkDefault} label="Think by default" onChange={(on) => save({ thinkDefault: on })} />
      </div>
      <div className="row slider-row">
        <div className="slider-head">
          <label htmlFor="budget">Thinking budget</label>
          <span>{budget === 0 ? "Off" : `${budget / 1024}K tokens`}</span>
        </div>
        {/* Native slider; the datalist gives it system tick marks. */}
        <input
          id="budget"
          type="range"
          min={0}
          max={max}
          step={1024}
          list="budget-ticks"
          value={budget}
          onChange={(e) => save({ thinkingBudget: Number(e.target.value) })}
        />
        <datalist id="budget-ticks">
          {[0, 1024, 2048, 3072, 4096].map((v) => <option key={v} value={v} />)}
        </datalist>
        {p?.mtp && <div className="sub">Not applied to MTP models yet: mlx-vlm refuses a budget with a speculative drafter.</div>}
      </div>
    </section>
  );
}

function SystemPrompt({ value, save }: { value: string; save: (p: Partial<Settings>) => void }) {
  const [v, setV] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const change = (text: string) => {
    setV(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save({ systemPrompt: text }), 400);
  };
  return (
    <section className="block" aria-label="System prompt">
      <label htmlFor="sys" className="caption">System prompt</label>
      <textarea
        id="sys"
        className="prompt"
        rows={3}
        value={v}
        onChange={(e) => change(e.target.value)}
        onBlur={() => (clearTimeout(timer.current), v !== value && save({ systemPrompt: v }))}
      />
    </section>
  );
}

function MemoryList({ memories, setMemories }: { memories: Memory[]; setMemories: (m: Memory[]) => void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const fmt = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const add = async () => {
    const text = draft.trim();
    setAdding(false);
    setDraft("");
    if (!text) return;
    const m = await api.addMemory(text);
    setMemories([m, ...memories]);
    setSelected(m.id);
  };
  const remove = async () => {
    if (selected == null) return;
    await api.deleteMemory(selected);
    setMemories(memories.filter((m) => m.id !== selected));
    setSelected(null);
  };

  return (
    <section className="block" aria-label="Memory">
      <div className="caption split">
        <span>Memory</span>
        <span>{memories.length} {memories.length === 1 ? "fact" : "facts"}</span>
      </div>
      <div className="group">
        <div role="listbox" aria-label="Saved facts" className="facts" onKeyDown={(e) => (e.key === "Backspace" || e.key === "Delete") && !adding && remove()}>
          {adding && (
            <div className="fact editing">
              <input
                autoFocus
                aria-label="New fact"
                placeholder="New fact"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === "Enter") add();
                  if (e.key === "Escape") (setAdding(false), setDraft(""));
                }}
              />
            </div>
          )}
          {memories.map((m) => (
            <button key={m.id} role="option" aria-selected={m.id === selected} className={"fact" + (m.id === selected ? " selected" : "")} onClick={() => setSelected(m.id)}>
              <span className="text">{m.text}</span>
              <span className="when">{fmt(m.created_at)}</span>
            </button>
          ))}
          {!adding && memories.length === 0 && <div className="fact empty">No facts yet.</div>}
        </div>
        <div className="list-footer">
          <button aria-label="Add fact" onClick={() => setAdding(true)}>+</button>
          <span aria-hidden="true" />
          <button aria-label="Remove selected fact" disabled={selected == null} onClick={remove}>−</button>
        </div>
      </div>
      <div className="footnote">Facts saved here are added to chats once memory ships (Milestone 3).</div>
    </section>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <section className="group">
      <div className="row"><span className="sub" style={{ margin: 0, fontSize: 13 }}>{children}</span></div>
    </section>
  );
}
