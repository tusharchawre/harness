// Starts mlx_vlm.server on demand and stops it after an idle period,
// so the model only holds GPU memory while it's being used.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { config, type ModelPreset } from "../config";

export type ModelStatus = "unloaded" | "loading" | "ready" | "error";
export type ModelState = { status: ModelStatus; presetId: string | null; label: string | null; error?: string; idleMinutes: number; lastUsed: number | null };

const LOAD_TIMEOUT_MS = 30 * 60_000; // first load may include a multi-GB download

export class ModelManager {
  readonly baseUrl = `http://127.0.0.1:${config.mlxPort}/v1`;
  private proc: ChildProcess | null = null;
  private loading: Promise<void> | null = null;
  private status: ModelStatus = "unloaded";
  private preset: ModelPreset | null = null; // loaded, or being loaded
  private error: string | undefined;
  private log: string[] = [];
  private busy = 0;
  private lastUsed: number | null = null;
  private listeners = new Set<(s: ModelState) => void>();

  constructor(public idleMinutes: number) {
    killStale();
    setInterval(() => this.checkIdle(), 30_000).unref();
  }

  state(): ModelState {
    const p = this.preset;
    return { status: this.status, presetId: p?.id ?? null, label: p?.label ?? null, error: this.error, idleMinutes: this.idleMinutes, lastUsed: this.lastUsed };
  }

  subscribe(fn: (s: ModelState) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(status: ModelStatus, error?: string) {
    this.status = status;
    this.error = error;
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  // One model in GPU memory at a time: asking for another preset swaps it in.
  async ensureReady(preset: ModelPreset): Promise<void> {
    while (this.loading) await this.loading.catch(() => {});
    if (this.status === "ready" && this.preset?.id === preset.id) return;
    if (this.proc) await this.unload();
    this.loading = this.load(preset).finally(() => (this.loading = null));
    return this.loading;
  }

  // Wrap a request so the idle timer never unloads mid-generation.
  async use<T>(fn: () => Promise<T>): Promise<T> {
    this.busy++;
    this.lastUsed = Date.now();
    try {
      return await fn();
    } finally {
      this.busy--;
      this.lastUsed = Date.now();
    }
  }

  private async load(preset: ModelPreset) {
    const model = preset.model;
    this.preset = preset;
    this.log = [];
    this.set("loading");

    if (await ping(`${this.baseUrl.replace(/\/v1$/, "")}/health`)) {
      this.set("error", `Port ${config.mlxPort} is already in use by another process.`);
      throw new Error(this.error);
    }

    const args = ["tool", "run", "--from", config.mlxVlmSpec, "mlx_vlm.server", "--model", model, "--host", "127.0.0.1", "--port", String(config.mlxPort)];
    if (preset.draftModel) args.push("--draft-model", preset.draftModel, "--draft-kind", preset.draftKind ?? "mtp");
    // detached = own process group, so we can kill uv and its python child together.
    const proc = spawn(config.uvBin, args, { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    const capture = (b: Buffer) => {
      this.log.push(...b.toString().split("\n").filter(Boolean));
      this.log = this.log.slice(-40);
    };
    proc.stdout!.on("data", capture);
    proc.stderr!.on("data", capture);
    if (proc.pid) writeFileSync(config.pidFile, String(proc.pid));

    let exited = false;
    proc.on("error", (e) => this.log.push(String(e)));
    proc.on("exit", (code) => {
      exited = true;
      if (this.proc === proc) {
        this.proc = null;
        rmSync(config.pidFile, { force: true });
        if (this.status !== "unloaded") this.set("error", `mlx_vlm.server exited (${code}): ${this.log.slice(-5).join(" | ")}`);
      }
    });

    try {
      const deadline = Date.now() + LOAD_TIMEOUT_MS;
      while (!(await ping(`${this.baseUrl.replace(/\/v1$/, "")}/health`))) {
        if (exited) throw new Error(this.error ?? "mlx_vlm.server exited");
        if (Date.now() > deadline) throw new Error("Timed out waiting for mlx_vlm.server");
        await Bun.sleep(500);
      }
      // A 1-token request blocks until the weights (and the drafter, which loads lazily) are in memory.
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
      });
      if (!res.ok) throw new Error(`warmup failed ${res.status}: ${await res.text()}`);
      this.lastUsed = Date.now();
      this.set("ready");
    } catch (e) {
      const tail = this.log.filter((l) => /error|exception/i.test(l)).slice(-2).join("\n");
      await this.unload();
      this.set("error", [e instanceof Error ? e.message : String(e), tail].filter(Boolean).join("\n"));
      throw e;
    }
  }

  async unload() {
    const proc = this.proc;
    this.proc = null;
    this.preset = null;
    if (proc?.pid && proc.exitCode === null) {
      const done = new Promise((r) => proc.once("exit", r));
      killGroup(proc.pid, "SIGTERM");
      const timeout = Bun.sleep(5000).then(() => "timeout");
      if ((await Promise.race([done, timeout])) === "timeout") killGroup(proc.pid, "SIGKILL");
    }
    rmSync(config.pidFile, { force: true });
    this.set("unloaded");
  }

  // Synchronous, for process exit handlers.
  killNow() {
    if (this.proc?.pid) killGroup(this.proc.pid, "SIGTERM");
    rmSync(config.pidFile, { force: true });
  }

  private checkIdle() {
    if (this.status !== "ready" || this.busy > 0 || this.lastUsed === null) return;
    if (Date.now() - this.lastUsed > this.idleMinutes * 60_000) {
      console.log(`[model] idle ${this.idleMinutes} min, unloading`);
      void this.unload();
    }
  }
}

function killGroup(pid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pid, sig);
  } catch {}
}

// A previous server run that died hard (e.g. bun --watch restart) can leave mlx_vlm.server behind.
function killStale() {
  if (!existsSync(config.pidFile)) return;
  const pid = Number(readFileSync(config.pidFile, "utf8"));
  if (pid) killGroup(pid, "SIGTERM");
  rmSync(config.pidFile, { force: true });
}

async function ping(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}
