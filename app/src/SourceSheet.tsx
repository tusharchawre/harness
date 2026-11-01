import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Source } from "./api";
import { Icon } from "./icons";
import { MarkdownDoc } from "./Markdown";
import { isTauri, reveal } from "./native";

const base = (p: string) => p.split("/").pop() ?? p;
const folder = (p: string) => p.slice(0, p.lastIndexOf("/")).replace(/^\/Users\/[^/]+/, "~") || "/";

// Right-hand glass sheet for a cited note: the file as markdown, the cited passage highlighted
// and scrolled into view, Show in Finder. Closing animates out before `onClosed` unmounts it.
export function SourceSheet({ source, closing, onClose, onClosed }: { source: Source; closing: boolean; onClose: () => void; onClosed: () => void }) {
  const [doc, setDoc] = useState<{ content: string } | { error: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const md = !/\.txt$/i.test(source.path);

  useEffect(() => {
    let live = true;
    setDoc(null);
    api.file(source.path).then(
      (r) => live && setDoc({ content: r.content }),
      (e) => live && setDoc({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => void (live = false);
  }, [source.path]);

  useLayoutEffect(() => {
    const hit = bodyRef.current?.querySelector(".cited, mark");
    if (hit) hit.scrollIntoView({ block: "center" });
    else bodyRef.current?.scrollTo({ top: 0 });
  }, [doc, source.quote]);

  useEffect(() => {
    if (closing && matchMedia("(prefers-reduced-motion: reduce)").matches) onClosed();
  }, [closing]);

  const text = doc && "content" in doc ? doc.content : null;
  const at = text && source.quote ? text.indexOf(source.quote) : -1;
  return (
    <aside
      className={"source glass" + (closing ? " closing" : "")}
      aria-label="Source preview"
      onAnimationEnd={(e) => e.target === e.currentTarget && closing && onClosed()}
    >
      <div className="head">
        <div className="names">
          <b>{source.title ?? base(source.path)}</b>
          <span>{folder(source.path)}</span>
        </div>
        {isTauri && (
          <button className="icon-btn" aria-label="Show in Finder" title="Show in Finder" onClick={() => reveal(source.path)}>
            <Icon name="folder" size={14} stroke={1.8} />
          </button>
        )}
        <button className="icon-btn" aria-label="Close preview" title="Close (Esc)" onClick={onClose}>
          <Icon name="close" size={12} stroke={2.4} />
        </button>
      </div>
      <div ref={bodyRef} className={"source-body" + (md ? " md" : "")}>
        {!doc ? (
          <div className="meta shimmer">Loading…</div>
        ) : "error" in doc ? (
          <div className="meta">Couldn't open this file ({doc.error}).</div>
        ) : md ? (
          <MarkdownDoc text={doc.content} cite={source.quote} />
        ) : (
          <pre className="source-plain">
            {at < 0 ? text : <>{text!.slice(0, at)}<mark className="inline">{source.quote}</mark>{text!.slice(at + source.quote!.length)}</>}
          </pre>
        )}
      </div>
    </aside>
  );
}
