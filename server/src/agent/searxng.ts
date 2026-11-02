// Runs SearXNG (meta search engine, from source in a uv venv) only while web search is in use:
// started on the first search, stopped after an idle period. Same idea as ModelManager.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

const START_TIMEOUT_MS = 60_000;
const pidFile = join(config.searxDir, "harness.pid");

export type SearchResult = { title: string; url: string; content?: string };

class SearxManager {
  readonly baseUrl = `http://127.0.0.1:${config.searxPort}`;
  private proc: ChildProcess | null = null;
  private starting: Promise<void> | null = null;
  private lastUsed = 0;
  private log: string[] = [];

  constructor() {
    killStale();
    setInterval(() => this.checkIdle(), 30_000).unref();
  }

  async search(query: string): Promise<SearchResult[]> {
    await this.ensureRunning();
    this.lastUsed = Date.now();
    const url = `${this.baseUrl}/search?${new URLSearchParams({ q: query, format: "json" })}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`SearXNG ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { results: SearchResult[] };
    this.lastUsed = Date.now();
    return data.results;
  }

  private ensureRunning() {
    if (this.proc && this.proc.exitCode === null) return Promise.resolve();
    return (this.starting ??= this.start().finally(() => (this.starting = null)));
  }

  private async start() {
    const python = join(config.searxDir, ".venv/bin/python");
    const settings = join(config.searxDir, "harness-settings.yml");
    if (!existsSync(python) || !existsSync(settings))
      throw new Error("Web search isn't set up. Run harness/server/scripts/setup-searxng.sh once.");
    if (await ping(`${this.baseUrl}/healthz`)) throw new Error(`Port ${config.searxPort} is already in use by another process.`);

    this.log = [];
    // detached = own process group, so the whole tree goes on kill.
    const proc = spawn(python, ["-m", "searx.webapp"], {
      cwd: config.searxDir,
      env: { ...process.env, SEARXNG_SETTINGS_PATH: settings },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    const capture = (b: Buffer) => (this.log = [...this.log, ...b.toString().split("\n").filter(Boolean)].slice(-20));
    proc.stdout!.on("data", capture);
    proc.stderr!.on("data", capture);
    if (proc.pid) writeFileSync(pidFile, String(proc.pid));
    proc.on("exit", () => {
      if (this.proc === proc) (this.proc = null), rmSync(pidFile, { force: true });
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await ping(`${this.baseUrl}/healthz`))) {
      if (proc.exitCode !== null) throw new Error(`SearXNG exited: ${this.log.slice(-3).join(" | ")}`);
      if (Date.now() > deadline) {
        this.stop();
        throw new Error("Timed out waiting for SearXNG to start");
      }
      await Bun.sleep(300);
    }
    console.log("[search] SearXNG started");
  }

  // Synchronous, so exit handlers can call it too.
  stop() {
    const pid = this.proc?.pid;
    this.proc = null;
    if (pid) killGroup(pid);
    rmSync(pidFile, { force: true });
  }

  private checkIdle() {
    if (this.proc && !this.starting && Date.now() - this.lastUsed > config.searxIdleMinutes * 60_000) {
      console.log(`[search] idle ${config.searxIdleMinutes} min, stopping SearXNG`);
      this.stop();
    }
  }
}

// Left behind by a run that died hard. Only kill it if that PID still leads a searx process group.
function killStale() {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8"));
  rmSync(pidFile, { force: true });
  if (!pid) return;
  const [pgid, ...cmd] = Bun.spawnSync(["ps", "-o", "pgid=,command=", "-p", String(pid)]).stdout.toString().trim().split(/\s+/);
  if (Number(pgid) === pid && /searx\.webapp/.test(cmd.join(" "))) killGroup(pid);
}

function killGroup(pid: number) {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
}

async function ping(url: string) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

export const searx = new SearxManager();
