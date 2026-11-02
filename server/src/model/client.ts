// The one interface the rest of the server uses to talk to a model.
// Swap backends by writing another ModelClient.

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type StreamEvent =
  | { type: "reasoning"; text: string }
  | { type: "content"; text: string }
  | { type: "tool_call"; call: ToolCall } // emitted once the call is complete (end of stream)
  | { type: "usage"; promptTokens: number; completionTokens: number };

export type Sampling = { temperature: number; top_p: number; top_k: number; min_p: number; presence_penalty: number };

// Qwen3.5 model card, "general tasks". Greedy decoding (the server default) makes thinking loop.
export const QWEN_SAMPLING: Record<"thinking" | "instruct", Sampling> = {
  thinking: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5 },
  instruct: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 },
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[]; // OpenAI function specs; the server renders them into the chat template
  thinking: boolean;
  sampling?: Sampling;
  // Server-side cap on reasoning tokens (mlx-vlm closes </think> itself). Omit for no cap.
  thinkingBudget?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};

export interface ModelClient {
  stream(req: ChatRequest): AsyncGenerator<StreamEvent>;
}

// Any OpenAI-compatible /v1/chat/completions server (mlx_vlm.server, mlx_lm.server, llama.cpp, ...).
export class OpenAICompatClient implements ModelClient {
  constructor(private baseUrl: string) {}

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.tools?.length ? { tools: req.tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens ?? 8192,
        ...(req.sampling ?? QWEN_SAMPLING[req.thinking ? "thinking" : "instruct"]),
        // Qwen chat templates read this to switch thinking on/off.
        chat_template_kwargs: { enable_thinking: req.thinking },
        ...(req.thinkingBudget ? { thinking_budget: req.thinkingBudget } : {}),
      }),
    });
    yield* readSSE(res);
  }
}

async function* readSSE(res: Response): AsyncGenerator<StreamEvent> {
  if (!res.ok || !res.body) throw new Error(`model server ${res.status}: ${await res.text()}`);
  const decoder = new TextDecoder();
  let buf = "";
  // The server parses the model's <tool_call> text into OpenAI tool_calls and streams them in
  // pieces keyed by index: the first piece has id + name, later ones append to arguments.
  const calls: ToolCall[] = [];
  read: for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break read;
      const json = JSON.parse(data);
      const choice = json.choices?.[0];
      const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
      if (reasoning) yield { type: "reasoning", text: reasoning };
      const text = choice?.delta?.content;
      if (text) yield { type: "content", text };
      for (const d of choice?.delta?.tool_calls ?? []) {
        const c = (calls[d.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (d.id) c.id = d.id;
        if (d.function?.name) c.function.name += d.function.name;
        if (d.function?.arguments) c.function.arguments += d.function.arguments;
      }
      if (json.usage) {
        yield { type: "usage", promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens };
      }
    }
  }
  for (const [i, call] of calls.entries()) if (call) yield { type: "tool_call", call: { ...call, id: call.id || `call_${i}` } };
}