import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Memory, type Preset, type Settings } from "./api";
import { Icon, type IconName } from "./icons";

export type Pane = "general" | "models" | "tools" | "memory" | "voice";

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

export const isPane = (p: string): p is Pane => PANES.some((x) => x.id === p);

// Settings as a sheet over the chat window. Mount it to open; `onClosed` fires after the
// close animation so the parent can unmount it.
export function SettingsModal(props: { pane: Pane; closing: boolean; onClose: () => void; onClosed: () => void; onSaved: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [offline, setOffline] = useState(false);
  const [q, setQ] = useState("");
  const [phase, setPhase] = useState<"enter" | "open" | "settled" | "closing">("enter");

  const panelRef = useRef<HTMLDivElement>(null);
  // Back/forward like System Settings: a history of panes and a cursor.
  const [nav, setNav] = useState<{ stack: Pane[]; at: number }>(() => ({ stack: [props.pane], at: 0 }));
  const pane = nav.stack[nav.at];
  const go = (p: Pane) => setNav((n) => (n.stack[n.at] === p ? n : { stack: [...n.stack.slice(0, n.at + 1), p], at: n.at + 1 }));

  useEffect(() => go(props.pane), [props.pane]);

  useEffect(() => {
    let alive = true;
    const boot = () =>
      Promise.all([api.settings().then(setSettings), api.models().then(setPresets), api.memories().then(setMemories)])
        .then(() => setOffline(false))
        .catch(() => alive && (setOffline(true), setTimeout(boot, 1500)));
    boot();
    // Two frames so the starting styles are painted before the transition.
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase("open")));

    // With Reduce Motion there's no transform transition to wait for.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setTimeout(() => setPhase((p) => (p === "open" ? "settled" : p)), 200);
    panelRef.current?.focus();
    return () => void (alive = false);
  }, []);

  useEffect(() => {
    if (!props.closing) return;
    setPhase("closing");
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setTimeout(props.onClosed, 160);
  }, [props.closing]);

  useEffect(() => {
    // Fields that use Esc themselves (renaming a fact) call preventDefault.
    const esc = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && props.onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [props.onClose]);

  // Every change saves straight away and applies to the chat window.
  const save = (patch: Partial<Settings>) => {
    setSettings((s) => s && { ...s, ...patch });
    api.saveSettings(patch).then((saved) => {
      setSettings((cur) => (cur ? { ...saved, systemPrompt: cur.systemPrompt } : saved));
      props.onSaved(saved);
    });
  };

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return needle ? PANES.filter((p) => (p.label + " " + p.keywords).toLowerCase().includes(needle)) : PANES;
  }, [q]);

  const title = PANES.find((p) => p.id === pane)!.label;
  const s = settings;


  return (
    <div className="modal-root" data-phase={phase}>
      <div className="modal-backdrop" onMouseDown={props.onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        className="settings-modal"
        onTransitionEnd={(e) => {
          if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
          if (phase === "open") setPhase("settled");
          if (phase === "closing") props.onClosed();
        }}
      >
        <nav className="settings-nav" aria-label="Settings sections">
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
          <div className="settings-toolbar">
            <div className="history">
              <button className="icon-btn" aria-label="Back" disabled={nav.at === 0} onClick={() => setNav((n) => ({ ...n, at: n.at - 1 }))}>
                <Icon name="chevronLeft" size={12} stroke={2.8} />
              </button>
              <button className="icon-btn" aria-label="Forward" disabled={nav.at === nav.stack.length - 1} onClick={() => setNav((n) => ({ ...n, at: n.at + 1 }))}>
                <Icon name="chevronRight" size={12} stroke={2.8} />
              </button>
            </div>
            <h1>{title}</h1>
            <button className="icon-btn close" aria-label="Close settings" title="Close (Esc)" onClick={props.onClose}>
              <Icon name="close" size={11} stroke={2.4} />
            </button>
          </div>

          <div className="settings-scroll">
            <div className="settings-content" key={pane}>
              <>
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
              </>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// Popup button: a <select> (its menu is the real macOS menu), drawn like NSPopUpButton.
function Popup<T extends string | number>(props: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="popup">
      <select
        aria-label={props.label}
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

function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={"switch" + (on ? " on" : "")} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

// Follows the pointer smoothly while dragging; on release it glides to the nearest tick
// and only then saves. Arrow keys still move tick by tick.
function SnapSlider({ label, value, max, step, onCommit }: { label: string; value: number; max: number; step: number; onCommit: (v: number) => void }) {
  const [pos, setPos] = useState(value);
  const dragging = useRef(false);
  const anim = useRef(0);
  const posRef = useRef(value);
  posRef.current = pos;

  useEffect(() => {
    if (!dragging.current) glide(value, false);
  }, [value]);
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  function glide(to: number, commit: boolean) {
    cancelAnimationFrame(anim.current);
    const from = posRef.current;
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPos(to);
      if (commit && to !== value) onCommit(to);
      return;
    }
    const t0 = performance.now();
    const dur = 260;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - t, 3); // ease-out
      setPos(from + (to - from) * e);
      if (t < 1) anim.current = requestAnimationFrame(tick);
      else if (commit && to !== value) onCommit(to);
    };
    anim.current = requestAnimationFrame(tick);
  }

  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    glide(Math.round(posRef.current / step) * step, true);
  };
  const target = Math.round(pos / step) * step;
  const ticks = Math.round(max / step) + 1;

  return (
    <>
      <span className="slider-value" aria-live="polite">{target === 0 ? "Off" : `${target / 1024}K tokens`}</span>
      <input
        aria-label={label}
        aria-valuetext={target === 0 ? "Off" : `${target / 1024}K tokens`}
        className="tahoe"
        type="range"
        min={0}
        max={max}
        step="any"
        value={pos}
        onPointerDown={() => {
          cancelAnimationFrame(anim.current);
          dragging.current = true;
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onBlur={release}
        onKeyDown={(e) => {
          const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          const next = Math.max(0, Math.min(max, target + dir * step));
          glide(next, true);
        }}
        onChange={(e) => {
          if (dragging.current) setPos(Number(e.target.value));
        }}
        style={{ ["--fill" as string]: `${(pos / max) * 100}%` }}
      />
      <div className="ticks" aria-hidden="true">
        {Array.from({ length: ticks }, (_, i) => <span key={i} className={i * step <= pos + 1 ? "on" : ""} />)}
      </div>
    </>
  );
}

function ModelGroup({ s, presets, save }: { s: Settings; presets: Preset[]; save: (p: Partial<Settings>) => void }) {
  const p = presets.find((x) => x.id === s.defaultModel) ?? presets[0];
  return (
    <section className="group" aria-label="Model">
      <div className="row">
        <div className="grow">
          Model
          <div className="sub">Used for new chats. Each chat can switch from the title bar.</div>
        </div>
        <Popup label="Model" value={s.defaultModel} options={presets.map((x) => ({ value: x.id, label: x.label }))} onChange={(v) => save({ defaultModel: v })} />
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
          <div>Unload model when idle</div>
          <div className="sub">{size ? `Frees ${size.startsWith("~") ? size : "~" + size}. ` : ""}Reloading takes ~10–30 s.</div>
        </div>
        <Popup label="Unload model when idle" value={s.idleMinutes} options={idle} onChange={(v) => save({ idleMinutes: v })} />
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
          <span>Thinking budget</span>
        </div>
        <SnapSlider label="Thinking budget" value={budget} max={max} step={1024} onCommit={(v) => save({ thinkingBudget: v })} />
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
                  if (e.key === "Escape") (e.preventDefault(), setAdding(false), setDraft(""));
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
          <button aria-label="Add fact" title="Add fact" onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} stroke={2} />
          </button>
          <span aria-hidden="true" />
          <button aria-label="Remove selected fact" title="Remove selected fact" disabled={selected == null} onClick={remove}>
            <Icon name="minus" size={12} stroke={2} />
          </button>
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
