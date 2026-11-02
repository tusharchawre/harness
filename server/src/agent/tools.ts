// Tools the agent can call. Each one is described to the model as a JSON schema (OpenAI "function"
// format); the chat template turns these into text in the system prompt.

import { fetchPage, webSearch } from "./web";

// A source the answer can cite: shown as a chip under the reply. `path` is a file path or a URL.
export type Source = { path: string; title?: string; quote?: string };

export type Tool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema of the arguments object
  // Text goes back to the model; sources and via (which service answered) go to the UI.
  run(args: Record<string, unknown>): Promise<string | { text: string; sources?: Source[]; via?: string }>;
};

export const toolSpec = (t: Tool) => ({
  type: "function" as const,
  function: { name: t.name, description: t.description, parameters: t.parameters },
});

const calculator: Tool = {
  name: "calculator",
  description:
    "Evaluate an arithmetic expression exactly. Use it for any arithmetic beyond trivial mental math. " +
    "Supports + - * / % ^, parentheses, pi, e, and sqrt, abs, ln, log10, exp, sin, cos, tan, floor, ceil, round.",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "e.g. (17.5 * 1.18)^2 / sqrt(3)" } },
    required: ["expression"],
  },
  async run(args) {
    const expr = String(args.expression ?? "");
    const value = evaluate(expr);
    if (!Number.isFinite(value)) throw new Error(`result is not a finite number: ${value}`);
    return String(Number(value.toPrecision(15)));
  },
};

export const tools: Tool[] = [calculator, webSearch, fetchPage];

// ---- calculator: a small recursive-descent parser (never eval model output) ----
// expr   = term (("+" | "-") term)*
// term   = unary (("*" | "/" | "%") unary)*
// unary  = "-" unary | power
// power  = atom ("^" unary)?          right-associative, binds tighter than unary minus on its left
// atom   = number | name | name "(" expr ")" | "(" expr ")"
const FUNCS: Record<string, (x: number) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, log10: Math.log10, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluate(src: string): number {
  const tokens = src.replace(/×/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^").match(/\d*\.?\d+(?:e[+-]?\d+)?|[a-z_]\w*|\S/gi) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const take = (t?: string) => {
    if (t && tokens[i] !== t) throw new Error(`expected "${t}" at token ${i + 1} of ${src}`);
    return tokens[i++];
  };

  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") v = take() === "+" ? v + term() : v - term();
    return v;
  };
  const term = (): number => {
    let v = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = take();
      const r = unary();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const unary = (): number => (peek() === "-" ? (take(), -unary()) : peek() === "+" ? (take(), unary()) : power());
  const power = (): number => {
    const base = atom();
    return peek() === "^" ? (take(), base ** unary()) : base;
  };
  const atom = (): number => {
    const t = take();
    if (t === undefined) throw new Error(`unexpected end of ${src}`);
    if (t === "(") {
      const v = expr();
      take(")");
      return v;
    }
    if (/^[\d.]/.test(t)) return Number(t);
    const name = t.toLowerCase();
    if (name in FUNCS) {
      take("(");
      const v = expr();
      take(")");
      return FUNCS[name](v);
    }
    if (name in CONSTS) return CONSTS[name];
    throw new Error(`unknown token "${t}"`);
  };

  const v = expr();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}" in ${src}`);
  return v;
}
