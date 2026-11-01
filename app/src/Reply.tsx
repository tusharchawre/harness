import { useState, type ReactNode } from "react";
import type { ToolStep } from "./api";
import { Icon } from "./icons";

// What sits above a reply's text: "Thought for Ns" and "Used N tools", each a disclosure.
// While the model reasons, "Thinking…" shimmers and the reasoning streams in a short window that
// collapses away once the answer starts. Tool rows slide in with a spinner, then result and time.

function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={"collapse" + (open ? " open" : "")} aria-hidden={!open}>
      <div>{children}</div>
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
  const [showReasoning, setShowReasoning] = useState(false);
  const [showTools, setShowTools] = useState<boolean | null>(null); // null: follow `live`
  const { reasoning, tools } = props;
  if (!reasoning && !tools.length) return null;

  const pending = tools.some((t) => t.result === undefined);
  const toolsOpen = showTools ?? !!props.live;
  return (
    <div className="extras">
      <div className="disclosures">
        {reasoning &&
          (props.thinkingNow ? (
            <span className="disc"><span className="shimmer">Thinking…</span></span>
          ) : (
            <button className="disc" aria-expanded={showReasoning} onClick={() => setShowReasoning((o) => !o)}>
              {props.thinkingMs != null ? `Thought for ${secs(props.thinkingMs)}` : "Thoughts"}
              <Icon name="chevronRight" size={10} stroke={3} />
            </button>
          ))}
        {tools.length > 0 && (
          <button className="disc" aria-expanded={toolsOpen} onClick={() => setShowTools(!toolsOpen)}>
            {pending ? <span className="shimmer">Using tools…</span> : `Used ${tools.length} ${tools.length === 1 ? "tool" : "tools"}`}
            <Icon name="chevronRight" size={10} stroke={3} />
          </button>
        )}
      </div>
      {reasoning && (
        <Collapse open={!!props.thinkingNow || showReasoning}>
          <div className={"reasoning-text" + (props.thinkingNow ? " live" : "")}>
            <div>{reasoning}</div>
          </div>
        </Collapse>
      )}
      {tools.length > 0 && (
        <Collapse open={toolsOpen}>
          <div className="trace">
            {tools.map((t) => (
              <div key={t.id} className="trace-row">
                <span className="call" title={callLabel(t)}>{callLabel(t)}</span>
                <span className="time">{t.result === undefined ? <span className="spinner" aria-label="Running" /> : duration(t.ms)}</span>
                {t.result !== undefined && <span className={"result" + (t.error ? " err" : "")}>{t.result}</span>}
              </div>
            ))}
          </div>
        </Collapse>
      )}
    </div>
  );
}
