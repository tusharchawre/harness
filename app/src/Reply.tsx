import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ToolStep } from "./api";
import { Icon, type IconName } from "./icons";
import { Markdown } from "./Markdown";

// What sits above a reply's text: thinking and tool use, each its own collapsible card.
// Thinking is open while the model reasons (newest lines kept in view) and folds to
// "Thought for Ns" once the answer starts; a click on the header toggles it either way.
// Tool rows slide in with a spinner, then settle to result and time.

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={"collapse" + (open ? " open" : "")} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}

function Card(props: { icon: IconName; label: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={"card" + (props.open ? " open" : "")}>
      <button className="card-head" aria-expanded={props.open} onClick={props.onToggle}>
        <Icon name={props.icon} size={13} stroke={1.8} />
        <span className="label">{props.label}</span>
        <Icon name="chevronDown" size={10} stroke={3} />
      </button>
      <Collapse open={props.open}>{props.children}</Collapse>
    </section>
  );
}

// Reasoning body: its own scroll box. While live it sticks to the bottom unless the user scrolled up in it.
function Thoughts({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, live]);
  return (
    <div
      ref={ref}
      className={"card-body thoughts" + (live ? " live" : "")}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.clientHeight - el.scrollTop < 24;
      }}
    >
      <Markdown text={text} streaming={live} />
    </div>
  );
}

const secs = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const duration = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

// search_notes({"query":"LoRA"}) → search_notes("LoRA")
function callLabel(t: ToolStep) {
  try {
    const v = JSON.parse(t.args);
    const parts = v && typeof v === "object" ? Object.values(v).map((x) => JSON.stringify(x)) : [JSON.stringify(v)];
    return `${t.name}(${parts.join(", ")})`;
  } catch {
    return `${t.name}(${t.args})`;
  }
}

export function ReplyExtras(props: {
  reasoning: string | null;
  thinkingMs: number | null;
  tools: ToolStep[];
  thinkingNow?: boolean; // reasoning is streaming and no answer yet
  live?: boolean; // part of the reply still streaming
}) {
  // null: follow the stream (open while thinking / while tools run); a click pins it.
  const [showReasoning, setShowReasoning] = useState<boolean | null>(null);
  const [showTools, setShowTools] = useState<boolean | null>(null);
  const { reasoning, tools } = props;
  if (!reasoning && !tools.length) return null;

  const pending = tools.some((t) => t.result === undefined);
  const reasoningOpen = showReasoning ?? !!props.thinkingNow;
  const toolsOpen = showTools ?? (!!props.live && pending);
  return (
    <div className="extras">
      {reasoning && (
        <Card
          icon="memory"
          open={reasoningOpen}
          onToggle={() => setShowReasoning(!reasoningOpen)}
          label={props.thinkingNow ? <span className="shimmer">Thinking…</span> : props.thinkingMs != null ? `Thought for ${secs(props.thinkingMs)}` : "Thoughts"}
        >
          <Thoughts text={reasoning} live={!!props.thinkingNow} />
        </Card>
      )}
      {tools.length > 0 && (
        <Card
          icon="tools"
          open={toolsOpen}
          onToggle={() => setShowTools(!toolsOpen)}
          label={pending ? <span className="shimmer">Using tools…</span> : `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}
        >
          <div className="card-body trace">
            {tools.map((t) => (
              <div key={t.id} className="trace-row">
                <span className="call" title={callLabel(t)}>{callLabel(t)}</span>
                <span className="time">{t.result === undefined ? <span className="spinner" aria-label="Running" /> : duration(t.ms)}</span>
                {t.result !== undefined && <span className={"result" + (t.error ? " err" : "")}>{t.result}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
