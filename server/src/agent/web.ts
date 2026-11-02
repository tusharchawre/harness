// web_search (SearXNG) and fetch_page (page → readable text).
import { lookup } from "node:dns/promises";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { search } from "./search";
import type { ToolContext } from "./permissions";
import type { Tool } from "./tools";

const MAX_RESULTS = 6;
const MAX_PAGE_CHARS = 8000; // ~2k tokens: enough for an article, small enough for prompt processing
const MAX_REDIRECTS = 5;

export const webSearch: Tool = {
  name: "web_search",
  description:
    "Search the web. Returns titles, URLs and short snippets. Snippets are often enough for simple facts; " +
    "call fetch_page on a result for details. Use for public, recent facts. Never for the user's own files, projects, code or notes: " +
    "those are on their Mac, so use find_files / grep_files / read_file instead.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Search query, like you would type into a search engine" } },
    required: ["query"],
  },
  async run(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query is empty");
    await confirmSend(ctx, "web_search", query);
    const { results, via } = await search(query, MAX_RESULTS);
    const text = results.length ? results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${(r.content ?? "").trim()}`).join("\n\n") : "No results.";
    return { text, via };
  },
};

export const fetchPage: Tool = {
  name: "fetch_page",
  description:
    "Fetch a web page and return its main text (navigation and ads removed), truncated if long. " +
    "Always call this when the user gives a URL or asks about a specific page; don't answer from memory.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Full http(s) URL" } },
    required: ["url"],
  },
  async run(args, ctx) {
    await confirmSend(ctx, "fetch_page", String(args.url ?? ""));
    const res = await safeFetch(String(args.url ?? ""));
    const type = res.headers.get("content-type") ?? "";
    let title: string | undefined;
    let text: string;
    if (type.includes("html")) {
      ({ title, text } = readable(await res.text(), res.url));
    } else if (type.startsWith("text/") || type.includes("json")) {
      text = await res.text();
    } else {
      throw new Error(`can't read ${type || "unknown content type"}`);
    }
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    const cut = text.length > MAX_PAGE_CHARS ? `\n\n[truncated: ${text.length - MAX_PAGE_CHARS} more characters]` : "";
    return {
      text: `${title ? `# ${title}\n\n` : ""}${text.slice(0, MAX_PAGE_CHARS)}${cut}`,
      sources: [{ path: res.url, title: title || new URL(res.url).hostname }],
    };
  },
};

// After a secret was read in this reply, anything leaving the Mac (a query or a URL could carry the
// secret) needs a yes first.
async function confirmSend(ctx: ToolContext, tool: string, target: string) {
  if (ctx.secretRead && !(await ctx.ask({ tool, path: target, action: "send", reason: ctx.secretRead })))
    throw new Error("the user declined this web request because a secret file was read earlier in this reply");
}

// The model picks the URL, so keep it off this machine and the local network (the Harness API,
// the model server and SearXNG all listen on localhost). Redirects are followed by hand so each
// hop is checked too.
async function safeFetch(raw: string) {
  let url = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http(s) URLs");
    // Check what the name resolves to as well, so a public name pointing at 127.0.0.1 is caught.
    const addrs = await lookup(u.hostname.replace(/^\[|\]$/g, ""), { all: true }).catch(() => []);
    if ([u.hostname, ...addrs.map((a) => a.address)].some(isPrivateHost)) throw new Error("local and private network addresses are blocked");
    const res = await fetch(u, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15", accept: "text/html,text/plain;q=0.9,*/*;q=0.5" },
    });
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      url = new URL(next, u).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // fetch with redirect: "manual" leaves res.url as the request URL, which is the final hop here.
    return Object.defineProperty(res, "url", { value: u.href });
  }
  throw new Error("too many redirects");
}

function isPrivateHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "0.0.0.0") return true;
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:")) return true;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

// Readability finds the main article; then a small walk turns its HTML into text with line breaks.
function readable(html: string, url: string) {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const root = article?.content ? parseHTML(`<html><body>${article.content}</body></html>`).document.body : document.body;
  return { title: (article?.title || document.title || "").trim(), text: toText(root as unknown as Node), url };
}

const BLOCK = /^(P|DIV|SECTION|ARTICLE|UL|OL|TABLE|TR|PRE|BLOCKQUOTE|FIGURE|H[1-6]|LI|BR|HR)$/;
function toText(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  if (/^(SCRIPT|STYLE|NOSCRIPT|SVG|IMG)$/.test(el.tagName)) return "";
  const inner = Array.from(el.childNodes).map(toText).join("");
  if (el.tagName === "PRE") return `\n${el.textContent}\n`;
  if (/^H[1-6]$/.test(el.tagName)) return `\n\n${"#".repeat(Number(el.tagName[1]))} ${inner.trim()}\n\n`;
  if (el.tagName === "LI") return `\n- ${inner.trim()}`;
  if (el.tagName === "TD" || el.tagName === "TH") return `${inner.trim()} | `;
  return BLOCK.test(el.tagName) ? `\n${inner.trim()}\n` : inner;
}
