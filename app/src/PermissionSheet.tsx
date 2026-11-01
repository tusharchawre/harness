import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

// Permission sheet (design canvas: Sheet.dc.html). The Milestone 2 agent loop awaits
// askPermission() before any tool writes, edits or deletes a file. Requests queue and show one at
// a time in their own root, so nothing in App needs wiring.

export type PermissionRequest = {
  tool: string; // e.g. "write_file"
  path: string;
  action?: "create" | "edit" | "delete"; // default "create"
  diff?: string; // unified-style lines: "+ added", "- removed", "  context"
};
export type PermissionAnswer = { allow: boolean; always: boolean };

type Pending = { req: PermissionRequest; resolve: (a: PermissionAnswer) => void };
const queue: Pending[] = [];
let root: Root | null = null;

export function askPermission(req: PermissionRequest): Promise<PermissionAnswer> {
  return new Promise((resolve) => {
    queue.push({ req, resolve });
    if (queue.length === 1) show();
  });
}

function show() {
  const next = queue[0];
  if (!next) return void (root?.unmount(), (root = null));
  if (!root) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
  }
  const done = (a: PermissionAnswer) => {
    next.resolve(a);
    queue.shift();
    show();
  };
  root.render(<PermissionSheet key={Date.now()} req={next.req} onAnswer={done} />);
}

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const name = (p: string) => p.split("/").pop() ?? p;
const folderName = (p: string) => p.split("/").slice(-2, -1)[0] ?? "this folder";

function copy(req: PermissionRequest) {
  const lines = req.diff ? req.diff.replace(/\n$/, "").split("\n") : [];
  const added = lines.filter((l) => l.startsWith("+")).length;
  const removed = lines.filter((l) => l.startsWith("-")).length;
  switch (req.action ?? "create") {
    case "edit":
      return { title: "Allow Harness to edit a file?", desc: `The model wants to change ${name(req.path)}.`, meta: `edit · +${added} −${removed}`, verb: "edits", lines };
    case "delete":
      return { title: "Allow Harness to delete a file?", desc: `The model wants to delete ${name(req.path)}.`, meta: "delete", verb: "deletes", lines };
    default:
      return { title: "Allow Harness to write a file?", desc: `The model wants to create a new file in ${folderName(req.path)}.`, meta: `new · ${lines.length} ${lines.length === 1 ? "line" : "lines"}`, verb: "writes", lines };
  }
}

function PermissionSheet({ req, onAnswer }: { req: PermissionRequest; onAnswer: (a: PermissionAnswer) => void }) {
  const [always, setAlways] = useState(false);
  const [closing, setClosing] = useState<PermissionAnswer | null>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const c = copy(req);

  const answer = (allow: boolean) => setClosing((cur) => cur ?? { allow, always: allow && always });
  // With Reduce Motion there's no exit animation to wait for.
  useEffect(() => {
    if (closing && matchMedia("(prefers-reduced-motion: reduce)").matches) onAnswer(closing);
  }, [closing]);

  // Enter = Allow Once (the default button), Esc = Deny. Capture phase so the chat's own Esc
  // (stop reply) and Settings' Esc don't also fire.
  useEffect(() => {
    allowRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" && e.key !== "Enter") return;
      if (e.key === "Enter" && document.activeElement instanceof HTMLButtonElement && document.activeElement !== allowRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      answer(e.key === "Enter");
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [always]);

  return (
    <div className={"perm-root" + (closing ? " closing" : "")} onAnimationEnd={(e) => e.target === e.currentTarget && closing && onAnswer(closing)}>
      <div className="perm-backdrop" />
      <div role="alertdialog" aria-modal="true" aria-labelledby="perm-title" aria-describedby="perm-desc" className="perm-sheet">
        <div className="perm-text">
          <h1 id="perm-title">{c.title}</h1>
          <p id="perm-desc">{c.desc}</p>
        </div>
        <div className="perm-well">
          <div className="perm-tool">
            <span>{req.tool}</span>
            <span className="meta">{c.meta}</span>
          </div>
          <div className="perm-path" title={req.path}>{tilde(req.path)}</div>
          {c.lines.length > 0 && (
            <pre className="perm-diff">
              {c.lines.map((l, i) => (
                <span key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : undefined}>{l || " "}</span>
              ))}
            </pre>
          )}
        </div>
        <label className="perm-always">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
          Always allow {c.verb} in this folder
        </label>
        <div className="perm-buttons">
          <button className="pill" onClick={() => answer(false)}>Deny</button>
          <button ref={allowRef} className="pill default" onClick={() => answer(true)}>Allow Once</button>
        </div>
      </div>
    </div>
  );
}
