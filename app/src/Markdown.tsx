import { createContext, memo, useContext, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cachedHighlight, highlight } from "./highlight";
import { openUrl } from "./native";

// Replies stream in as markdown. Finished blocks render as plain markdown (memoized, so long
// replies stay light); only the block still arriving wraps each word in a span that washes in.

type HNode = { type: string; tagName?: string; value?: string; children?: HNode[]; properties?: Record<string, unknown>; data?: { meta?: string | null }; position?: { end: { offset?: number } } };

// Split at blank lines outside code fences, unless the next line is indented (list or quote continuing).
export function splitBlocks(text: string): { blocks: string[]; open: boolean } {
  const lines = text.split("\n");
  const blocks: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (m && !fence) fence = m[1];
    else if (m && m[1][0] === fence![0] && m[1].length >= fence!.length && !m[2].trim()) fence = null;
    cur.push(line);
    if (!fence && !line.trim() && /^\S/.test(lines[i + 1] ?? "")) (blocks.push(cur.join("\n")), (cur = []));
  });
  blocks.push(cur.join("\n"));
  return { blocks, open: fence !== null };
}

// ---- streaming words ----

// Rehype plugin: text → <hw> per word (skips code; whitespace-only text stays as-is for tables/lists).
function rehypeWords() {
  const walk = (node: HNode) => {
    if (!node.children || node.tagName === "pre" || node.tagName === "code") return;
    node.children = node.children.flatMap((c): HNode[] => {
      if (c.type !== "text") return walk(c), [c];
      if (!c.value?.trim()) return [c];
      return c.value.match(/^\s+|\S+\s*/g)!.map((w) => (/^\s/.test(w) ? { type: "text", value: w } : { type: "element", tagName: "hw", properties: {}, children: [{ type: "text", value: w }] }));
    });
  };
  return (tree: HNode) => walk(tree);
}

// Words that land in one chunk are spaced a little apart so a burst reads as typing, not a pop.
const Pace = createContext({ last: 0 });
function Word({ children }: { children?: ReactNode }) {
  const pace = useContext(Pace);
  const [delay] = useState(() => {
    const now = performance.now();
    const at = Math.min(Math.max(now, pace.last + 22), now + 260);
    pace.last = at;
    return Math.round(at - now);
  });
  return <span className="w" style={{ "--d": `${delay}ms` } as React.CSSProperties}>{children}</span>;
}

// ---- code blocks ----

// Header label: ```ts tok-rate.ts, ```tok-rate.ts, ```ts:tok-rate.ts, or title="tok-rate.ts".
function parseFence(info: string | undefined, meta: string | null | undefined) {
  let lang = info;
  let file = /(?:title|file(?:name)?)=["']?([^"'\s]+)/.exec(meta ?? "")?.[1] ?? /^\s*([\w./-]+\.\w+)/.exec(meta ?? "")?.[1];
  if (lang?.includes(":")) [lang, file] = [lang.slice(0, lang.indexOf(":")), lang.slice(lang.indexOf(":") + 1)];
  if (lang?.includes(".")) (file = lang), (lang = lang.split(".").pop());
  return { lang: lang?.toLowerCase(), file };
}

const textOf = (n: HNode): string => n.value ?? n.children?.map(textOf).join("") ?? "";

function CodeBlock({ code, lang, file, open }: { code: string; lang?: string; file?: string; open: boolean }) {
  const [html, setHtml] = useState(() => cachedHighlight(code, lang));
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (open) return;
    let live = true;
    highlight(code, lang).then((h) => live && setHtml(h));
    return () => void (live = false);
  }, [code, lang, open]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div className="codeblock">
      <div className="head">
        <span>{file ?? lang ?? "text"}</span>
        <button onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {open ? (
        // Still streaming: each line washes in; highlighting waits for the closing fence.
        <pre><code>{code.split("\n").map((l, i) => <span key={i} className="line-in">{l || " "}</span>)}</code></pre>
      ) : html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre><code>{code}</code></pre>
      )}
    </div>
  );
}

// The block still arriving: its text, and whether its last code fence is unclosed.
const Tail = createContext<{ text: string; open: boolean } | null>(null);

function Pre({ node }: { node?: HNode }) {
  const tail = useContext(Tail);
  const code = node?.children?.find((c) => c.tagName === "code");
  if (!code) return null;
  const cls = (code.properties?.className as string[] | undefined)?.find((c) => c.startsWith("language-"));
  const { lang, file } = parseFence(cls?.slice(9), code.data?.meta);
  const open = !!tail?.open && (node!.position?.end.offset ?? 0) >= tail.text.trimEnd().length;
  return <CodeBlock code={textOf(code).replace(/\n$/, "")} lang={lang} file={file} open={open} />;
}

const components = {
  a: ({ href, children }) => (
    <a href={href} title={href} onClick={(e) => (e.preventDefault(), href && openUrl(href))}>{children}</a>
  ),
  table: ({ children }) => <div className="table"><table>{children}</table></div>,
  pre: Pre as Components["pre"],
  hw: Word,
} as Components;

const Block = memo(function Block({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>;
});

const wordPlugins = [rehypeWords];
function StreamingTail({ text, open }: { text: string; open: boolean }) {
  return (
    <Tail.Provider value={{ text, open }}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={wordPlugins} components={components}>{text}</ReactMarkdown>
    </Tail.Provider>
  );
}

export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const [pace] = useState(() => ({ last: 0 }));
  if (!streaming) return <div className="md"><Block text={text} /></div>;
  const { blocks, open } = splitBlocks(text);
  const tail = blocks.length - 1;
  return (
    <div className="md">
      <Pace.Provider value={pace}>
        {blocks.slice(0, tail).map((b, i) => <Block key={i} text={b} />)}
        <StreamingTail key={`t${tail}`} text={blocks[tail]} open={open} />
      </Pace.Provider>
    </div>
  );
});
