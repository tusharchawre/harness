import { useEffect, useRef } from "react";

// Inline permission request inside the reply being written (not a modal): the agent loop waits
// on it before reading a private file, or before a web request once one was read.

export type PermissionAsk = { id: string; tool: string; path: string; action: "read" | "send"; reason?: string; allowed?: boolean };

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const name = (p: string) => p.split("/").pop() ?? p;

export function PermissionCard({ ask, onAnswer }: { ask: PermissionAsk; onAnswer: (allow: boolean) => void }) {
  const allowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => allowRef.current?.focus({ preventScroll: true }), []);
  const read = ask.action === "read";

  if (ask.allowed !== undefined)
    return (
      <div className="perm-done">
        {ask.allowed ? "Allowed" : "Denied"} · {read ? `read ${tilde(ask.path)}` : `${ask.tool === "web_search" ? "search" : "fetch"} ${ask.path}`}
      </div>
    );

  return (
    <div className="perm-card" role="group" aria-label="Permission request">
      <div className="perm-card-text">
        <b>{read ? "Read a private file?" : "Allow a web request?"}</b>
        <span>
          {read
            ? `${name(ask.path)} can hold passwords or keys. The model will see its contents.`
            : `This reply read ${name(ask.reason ?? "a private file")}. A web request could carry its contents off this Mac.`}
        </span>
        <code title={ask.path}>{read ? tilde(ask.path) : ask.path}</code>
      </div>
      <div className="perm-card-buttons">
        <button className="pill" onClick={() => onAnswer(false)}>
          Deny
        </button>
        <button ref={allowRef} className="pill default" onClick={() => onAnswer(true)}>
          Allow
        </button>
      </div>
    </div>
  );
}
