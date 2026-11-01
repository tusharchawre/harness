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

export type ModelPreset = { id: string; label: string; model: string; draftModel?: string; draftKind?: string };

// DATA_DIR/models.json (same shape) replaces this list. The first entry is the default.
const DEFAULT_PRESETS: ModelPreset[] = [
  {
    id: "qwen3.5-9b-mtp",
    label: "Qwen3.5-9B + MTP",
    model: "mlx-community/Qwen3.5-9B-4bit",
    // Multi-token-prediction drafter: speculative decoding, ~1.5x faster, same answers.
    draftModel: "mlx-community/Qwen3.5-9B-MTP-4bit",
    draftKind: "mtp",
  },
  { id: "qwen3.5-4b", label: "Qwen3.5-4B", model: "mlx-community/Qwen3.5-4B-4bit" },
];
const presetsFile = join(DATA_DIR, "models.json");
export const presets: ModelPreset[] = existsSync(presetsFile) ? JSON.parse(readFileSync(presetsFile, "utf8")) : DEFAULT_PRESETS;
export const presetById = (id: string | null | undefined) => presets.find((p) => p.id === id) ?? presets[0];

export const config = {
  port: Number(process.env.HARNESS_PORT ?? 8787),
  mlxPort: Number(process.env.MLX_PORT ?? 8080),
  defaultIdleMinutes: Number(process.env.IDLE_MINUTES ?? 10),
  defaultThinkingBudget: Number(process.env.THINKING_BUDGET ?? 1024),
  // mlx-vlm rather than mlx_lm: only mlx-vlm runs Qwen3.5's MTP drafter.
  mlxVlmSpec: process.env.MLX_VLM_SPEC ?? "mlx-vlm==0.7.11",
  uvBin: findUv(),
  dbPath: join(DATA_DIR, "harness.db"),
  pidFile: join(DATA_DIR, "mlx.pid"),
  allowedOrigins: ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420", "http://127.0.0.1:1420"],
};
