// web_search backends, tried in order: Tavily → Exa → local SearXNG.
// A backend is skipped when it has no key or its monthly quota ran out; any error or an 8 s
// timeout moves on to the next one. A used-up quota is remembered until the 1st of next month.
import { settings } from "../db";
import { getKey } from "../keychain";
import { searx, type SearchResult } from "./searxng";

export type BackendId = "tavily" | "exa" | "searxng";
type Backend = { id: BackendId; label: string; needsKey: boolean; search(q: string, key: string, n: number): Promise<SearchResult[]> };

const TIMEOUT_MS = 8000;

class QuotaError extends Error {}

const tavily: Backend = {
  id: "tavily",
  label: "Tavily",
  needsKey: true,
  async search(query, key, n) {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: n, search_depth: "basic" }), // basic = 1 credit
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 432: key or plan limit reached, 433: pay-as-you-go limit reached.
    if (res.status === 432 || res.status === 433) throw new QuotaError(await errorText(res));
    if (!res.ok) throw new Error(await errorText(res));
    const data = (await res.json()) as { results: { title: string; url: string; content?: string }[] };
    return data.results.map((r) => ({ title: r.title, url: r.url, content: r.content }));
  },
};

const exa: Backend = {
  id: "exa",
  label: "Exa",
  needsKey: true,
  async search(query, key, n) {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query, numResults: n, contents: { highlights: { maxCharacters: 400 } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 402: credits used up, or the key's/team's spending budget reached.
    if (res.status === 402) throw new QuotaError(await errorText(res));
    if (!res.ok) throw new Error(await errorText(res));
    const data = (await res.json()) as { results: { title?: string; url: string; highlights?: string[] }[] };
    return data.results.map((r) => ({ title: r.title || r.url, url: r.url, content: r.highlights?.join(" … ") }));
  },
};

// Last resort, so no 8 s cap: a cold start alone takes ~5 s.
const searxng: Backend = { id: "searxng", label: "SearXNG", needsKey: false, search: (q) => searx.search(q) };

export const backends = [tavily, exa, searxng];

const month = (d = new Date()) => d.toISOString().slice(0, 7); // "2026-11"
const usageKey = (id: BackendId) => `searchUsage:${month()}:${id}`;
const exhaustedKey = (id: BackendId) => `searchExhausted:${id}`;
// Both free tiers top up monthly; Exa documents the 1st of the calendar month, Tavily doesn't say.
const nextMonthStart = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

export const exhaustedUntil = (id: BackendId) => {
  const until = Number(settings.get(exhaustedKey(id)) ?? 0);
  return until > Date.now() ? until : null;
};
export const clearExhausted = (id: BackendId) => settings.set(exhaustedKey(id), "0");

// What Settings › Tools shows.
export const searchStatus = () =>
  backends.map((b) => ({
    id: b.id,
    label: b.label,
    needsKey: b.needsKey,
    hasKey: !b.needsKey || !!getKey(b.id),
    searches: Number(settings.get(usageKey(b.id)) ?? 0), // successful searches this calendar month
    exhaustedUntil: exhaustedUntil(b.id),
  }));

export async function search(query: string, n: number): Promise<{ results: SearchResult[]; via: string }> {
  const failures: string[] = [];
  for (const b of backends) {
    const key = b.needsKey ? getKey(b.id) : "";
    if (key === null) continue; // not set up
    if (exhaustedUntil(b.id)) continue;
    try {
      const results = await b.search(query, key, n);
      settings.set(usageKey(b.id), String(Number(settings.get(usageKey(b.id)) ?? 0) + 1));
      return { results: results.slice(0, n), via: b.label };
    } catch (e) {
      const why = e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000} s` : e.message) : String(e);
      if (e instanceof QuotaError) {
        settings.set(exhaustedKey(b.id), String(nextMonthStart()));
        console.log(`[search] ${b.label} quota used up until ${new Date(nextMonthStart()).toISOString().slice(0, 10)}: ${why}`);
      }
      failures.push(`${b.label}: ${why}`);
    }
  }
  throw new Error(failures.length ? `all search backends failed (${failures.join("; ")})` : "no search backend available");
}

async function errorText(res: Response) {
  const body = (await res.text()).slice(0, 200);
  return `HTTP ${res.status}${body ? `: ${body}` : ""}`;
}
