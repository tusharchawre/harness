export const API = import.meta.env.VITE_API ?? "http://127.0.0.1:8787";

export type ModelStatus = "unloaded" | "loading" | "ready" | "error";
export type ModelState = { status: ModelStatus; presetId: string | null; label: string | null; error?: string; idleMinutes: number; lastUsed: number | null };
export type Settings = { idleMinutes: number; thinkingBudget: number };
export type Preset = { id: string; label: string; model: string; mtp: boolean; info: { size?: string; speed?: string; humaneval?: string } };
export type Chat = { id: string; title: string; preset: string | null; created_at: number; updated_at: number };
export type Message = {
  id: number;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  model: string | null;
  thinking: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tokens_per_sec: number | null;
  created_at: number;
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json();
}

export const api = {
  chats: () => json<Chat[]>("/api/chats"),
  chat: (id: string) => json<Chat & { messages: Message[] }>(`/api/chats/${id}`),
  createChat: (preset: string) => json<Chat>("/api/chats", { method: "POST", body: JSON.stringify({ preset }) }),
  setChatPreset: (id: string, preset: string) => json<Chat>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ preset }) }),
  models: () => json<Preset[]>("/api/models"),
  deleteChat: (id: string) => json(`/api/chats/${id}`, { method: "DELETE" }),
  settings: () => json<Settings>("/api/settings"),
  saveSettings: (s: Partial<Settings>) => json<Settings>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  loadModel: (preset: string) => json<ModelState>("/api/model/load", { method: "POST", body: JSON.stringify({ preset }) }),
  unloadModel: () => json<ModelState>("/api/model/unload", { method: "POST" }),
};

export function watchModel(onState: (s: ModelState) => void): () => void {
  const es = new EventSource(`${API}/api/model/events`);
  es.addEventListener("state", (e) => onState(JSON.parse((e as MessageEvent).data)));
  return () => es.close();
}

export type SendEvent =
  | { event: "user"; data: Message }
  | { event: "status"; data: { status: string; model?: string } }
  | { event: "reasoning" | "content"; data: { text: string } }
  | { event: "done"; data: Message }
  | { event: "error"; data: { message: string } };

// POST + SSE response, so EventSource can't be used; parse the stream by hand.
export async function sendMessage(
  chatId: string,
  content: string,
  thinking: boolean,
  onEvent: (e: SendEvent) => void,
  signal: AbortSignal,
) {
  const res = await fetch(`${API}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, thinking }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let sep;
    while ((sep = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trimStart();
      }
      if (data) onEvent({ event, data: JSON.parse(data) } as SendEvent);
    }
  }
}
