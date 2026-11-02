import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.HARNESS_DATA_DIR ?? join(homedir(), "Library", "Application Support", "harness");
mkdirSync(DATA_DIR, { recursive: true });

// Bun loads ./.env automatically in dev. The built app has no useful cwd,
// so also read DATA_DIR/.env. Real env vars always win.
const envFile = join(DATA_DIR, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function findUv(): string {
  if (process.env.UV_BIN) return process.env.UV_BIN;
  // GUI apps don't inherit the shell PATH, so check the usual install spots.
  const candidates = [join(homedir(), ".local/bin/uv"), "/opt/homebrew/bin/uv", "/usr/local/bin/uv", join(homedir(), ".cargo/bin/uv")];
  return candidates.find((p) => existsSync(p)) ?? Bun.which("uv") ?? "uv";
}

// `info` is display-only (model menu, Settings).
export type ModelInfo = { size?: string; speed?: string; humaneval?: string };
export type ModelPreset = { id: string; label: string; model: string; draftModel?: string; draftKind?: string; info?: ModelInfo };

// DATA_DIR/models.json (same shape) replaces this list. The first entry is the default.
const DEFAULT_PRESETS: ModelPreset[] = [
  {
    id: "qwen3.5-9b-mtp",
    label: "Qwen3.5-9B + MTP",
    model: "mlx-community/Qwen3.5-9B-4bit",
    // Multi-token-prediction drafter: speculative decoding, ~1.5x faster, same answers.
    draftModel: "mlx-community/Qwen3.5-9B-MTP-4bit",
    draftKind: "mtp",
    info: { size: "5.6 GB · 4-bit", speed: "~25 tokens/s", humaneval: "95% · 60%" },
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5-4B",
    model: "mlx-community/Qwen3.5-4B-4bit",
    info: { size: "~2.5 GB · 4-bit", speed: "~34 tokens/s", humaneval: "92.5% · 70%" },
  },
];
const presetsFile = join(DATA_DIR, "models.json");
export const presets: ModelPreset[] = existsSync(presetsFile) ? JSON.parse(readFileSync(presetsFile, "utf8")) : DEFAULT_PRESETS;
export const presetById = (id: string | null | undefined) => presets.find((p) => p.id === id) ?? presets[0];

export const DEFAULT_SYSTEM_PROMPT =
  "Be concise and direct. No emojis, no filler, no follow-up offers. Reply in English. Use tools when a question needs facts you don't have.";

export const config = {
  port: Number(process.env.HARNESS_PORT ?? 8787),
  mlxPort: Number(process.env.MLX_PORT ?? 8080),
  defaultIdleMinutes: Number(process.env.IDLE_MINUTES ?? 30),
  defaultThinkingBudget: Number(process.env.THINKING_BUDGET ?? 1024),
  // mlx-vlm rather than mlx_lm: only mlx-vlm runs Qwen3.5's MTP drafter.
  mlxVlmSpec: process.env.MLX_VLM_SPEC ?? "mlx-vlm==0.7.11",
  uvBin: findUv(),
  dbPath: join(DATA_DIR, "harness.db"),
  pidFile: join(DATA_DIR, "mlx.pid"),
  // SearXNG checkout + venv, made by scripts/setup-searxng.sh.
  searxDir: process.env.SEARXNG_DIR ?? join(DATA_DIR, "searxng"),
  searxPort: Number(process.env.SEARXNG_PORT ?? 8888),
  searxIdleMinutes: Number(process.env.SEARXNG_IDLE_MINUTES ?? 10),
  allowedOrigins: ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
};
