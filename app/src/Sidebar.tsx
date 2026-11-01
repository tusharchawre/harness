import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "./api";
import { Icon } from "./icons";
import { openSettings } from "./native";

const DAY = 86_400_000;

function groupChats(chats: Chat[]) {
  const today = new Date().setHours(0, 0, 0, 0);
  const groups: { label: string; chats: Chat[] }[] = [
    { label: "Today", chats: [] },
    { label: "Yesterday", chats: [] },
    { label: "Earlier", chats: [] },
  ];
  for (const c of chats) groups[c.updated_at >= today ? 0 : c.updated_at >= today - DAY ? 1 : 2].chats.push(c);
  return groups.filter((g) => g.chats.length);
}

// Sidebar toggle + new chat. Lives in the sidebar header, and in the title bar while the sidebar is hidden.
export function WindowButtons({ onToggle, onNew, compose = true }: { onToggle: () => void; onNew: () => void; compose?: boolean }) {
  return (
    <>
      <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle Sidebar (⌃⌘S)" onClick={onToggle}>
        <Icon name="sidebar" size={18} stroke={1.6} />
      </button>
      {compose && (
        <button className="icon-btn" aria-label="New chat" title="New Chat (⌘N)" onClick={onNew}>
          <Icon name="compose" size={17} stroke={1.6} />
        </button>
      )}
    </>
  );
}

type MenuState = { id: string; x: number; y: number };

export function Sidebar(props: {
  chats: Chat[];
  chatId: string | null;
  hidden: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onToggle: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groupChats(needle ? props.chats.filter((c) => c.title.toLowerCase().includes(needle)) : props.chats);
  }, [props.chats, q]);

  const openMenu = (id: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setMenu({ id, x: r.left, y: r.bottom + 4 });
  };

  return (
    <aside className={"sidebar glass" + (props.hidden ? " hidden" : "")} aria-hidden={props.hidden}>
      {/* The native traffic lights sit in the empty left part of this row. */}
      <div className="side-head" data-tauri-drag-region>
        <WindowButtons onToggle={props.onToggle} onNew={props.onNew} compose={false} />
        <button className="icon-btn" aria-label="New chat" title="New Chat (⌘N)" onClick={props.onNew}>
          <Icon name="compose" size={17} stroke={1.6} />
        </button>
      </div>
      <label className="search">
        <Icon name="search" size={13} stroke={2.2} />
        <input aria-label="Search chats" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      <nav className="chat-list">
        {groups.map((g) => (
          <div key={g.label} style={{ display: "contents" }}>
            <div className="group-label">{g.label}</div>
            {g.chats.map((c) =>
              renaming === c.id ? (
                <RenameRow key={c.id} title={c.title} onDone={(t) => (setRenaming(null), t && t !== c.title && props.onRename(c.id, t))} />
              ) : (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  aria-current={c.id === props.chatId ? "page" : undefined}
                  className={"chat-row" + (c.id === props.chatId ? " active" : "") + (menu?.id === c.id ? " menu-open" : "")}
                  onClick={() => props.onPick(c.id)}
                  onKeyDown={(e) => e.key === "Enter" && props.onPick(c.id)}
                  onContextMenu={(e) => (e.preventDefault(), setMenu({ id: c.id, x: e.clientX, y: e.clientY }))}
                >
                  <span>{c.title}</span>
                  <button
                    className="more"
                    aria-label="Chat options"
                    aria-haspopup="menu"
                    aria-expanded={menu?.id === c.id}
                    onClick={(e) => (e.stopPropagation(), menu?.id === c.id ? setMenu(null) : openMenu(c.id, e.currentTarget))}
                  >
                    <Icon name="more" size={14} />
                  </button>
                </div>
              ),
            )}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <button onClick={() => openSettings("memory")}>
          <Icon name="memory" />
          Memory
        </button>
        <button onClick={() => openSettings("general")}>
          <Icon name="settings" />
          Settings
        </button>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: "Rename", run: () => setRenaming(menu.id) },
            { label: "Delete Chat", destructive: true, run: () => props.onDelete(menu.id) },
          ]}
        />
      )}
    </aside>
  );
}

function RenameRow({ title, onDone }: { title: string; onDone: (title: string | null) => void }) {
  const [v, setV] = useState(title);
  const done = useRef(false);
  const finish = (t: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(t?.trim() || null);
  };
  return (
    <div className="chat-row active">
      <input
        className="rename"
        aria-label="Chat name"
        autoFocus
        value={v}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => finish(v)}
        onKeyDown={(e) => {
          if (e.key === "Enter") finish(v);
          if (e.key === "Escape") finish(null);
        }}
      />
    </div>
  );
}

export function ContextMenu(props: { x: number; y: number; onClose: () => void; items: { label: string; destructive?: boolean; run: () => void }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) props.onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", props.onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", props.onClose);
    };
  }, [props.onClose]);
  // Keep it inside the window.
  const left = Math.min(props.x, window.innerWidth - 176);
  const top = Math.min(props.y, window.innerHeight - 16 - props.items.length * 26);
  return (
    <div ref={ref} role="menu" className="ctx-menu" style={{ left, top }}>
      {props.items.map((it) => (
        <button key={it.label} role="menuitem" className={"item" + (it.destructive ? " destructive" : "")} onClick={() => (props.onClose(), it.run())}>
          {it.label}
        </button>
      ))}
    </div>
  );
}
