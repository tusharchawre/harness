import { useMemo, useState } from "react";
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

export function Sidebar(props: {
  chats: Chat[];
  chatId: string | null;
  hidden: boolean;
  onPick: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return groupChats(needle ? props.chats.filter((c) => c.title.toLowerCase().includes(needle)) : props.chats);
  }, [props.chats, q]);

  return (
    <aside className={"sidebar glass" + (props.hidden ? " hidden" : "")} aria-hidden={props.hidden}>
      {/* The native traffic lights sit in the empty left part of this row. */}
      <div className="side-head" data-tauri-drag-region>
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
            {g.chats.map((c) => (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-current={c.id === props.chatId ? "page" : undefined}
                className={"chat-row" + (c.id === props.chatId ? " active" : "")}
                onClick={() => props.onPick(c.id)}
                onKeyDown={(e) => e.key === "Enter" && props.onPick(c.id)}
              >
                <span>{c.title}</span>
                <button className="x" aria-label="Delete chat" title="Delete chat" onClick={(e) => (e.stopPropagation(), props.onDelete(c.id))}>
                  <Icon name="close" size={9} stroke={2.6} />
                </button>
              </div>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <button onClick={() => openSettings()}>
          <Icon name="memory" />
          Memory
        </button>
        <button onClick={() => openSettings()}>
          <Icon name="settings" />
          Settings
        </button>
      </div>
    </aside>
  );
}
