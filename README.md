# Harness

Mac app for chatting with open models that run locally. The model and chat history never leave the machine; web search queries go to Tavily or Exa (free tiers) with local SearXNG as the fallback.

```
React UI (Tauri webview) ⇄ SSE ⇄ bun sidecar (Hono, SQLite, model manager) ⇄ HTTP ⇄ mlx_vlm.server ⇄ GPU
```

| Path | What |
| --- | --- |
| `server/` | bun + Hono backend. All app logic lives here. Compiled into a single binary and shipped as a Tauri sidecar. |
| `server/src/model/client.ts` | The one model interface (`ModelClient`). Swap backends by adding another implementation. |
| `server/src/model/manager.ts` | Starts `mlx_vlm.server` on the first message, polls until ready, kills it after N idle minutes. One model in memory at a time. |
| `server/src/config.ts` | Model presets (`DEFAULT_PRESETS`) and env config. |
| `server/src/db.ts` | SQLite (bun:sqlite): chats, messages, settings. |
| `app/` | Vite + React + TypeScript UI. |
| `app/src-tauri/` | Tauri v2 shell. Rust only starts and stops the sidecar. |

## Milestone 1: Chat

- Streaming chat, history in SQLite (`~/Library/Application Support/harness/harness.db`)
- Model loads on demand, unloads after 30 idle minutes (configurable, or never), header shows unloaded / loading / ready, plus "Unload now"
- Each reply shows the model name, token count and decode tokens/sec
- Thinking on/off toggle (passes `enable_thinking` to the Qwen chat template); reasoning shows in a collapsible block and isn't sent back as context
- Model dropdown per chat: **Qwen3.5-9B + MTP** (default) or **Qwen3.5-4B**. Switching swaps the loaded model on the next message (~10–30 s)
- Model server is **mlx-vlm**, not mlx_lm: only mlx-vlm runs Qwen3.5's multi-token-prediction (MTP) drafter. 9B + MTP decodes ~1.5× faster (25 vs 17 tok/s, same pass@1 on the code eval)
- Thinking budget (default 1024 tokens), enforced by mlx-vlm's `thinking_budget`. **Not applied to MTP presets**: mlx-vlm refuses a budget while a speculative drafter is loaded, so 9B + MTP thinks uncapped for now
- Sampling follows the Qwen3.5 model card (`QWEN_SAMPLING` in `client.ts`); greedy decoding makes thinking loop

## Milestone 2: Tools (in progress)

- Hand-written agent loop in `server/src/index.ts`: model → tool calls → run → results back → repeat, max 6 model calls per reply
- Tools live in `server/src/agent/tools.ts`. Done: `calculator` (own parser, never `eval`), `web_search`, `fetch_page`, `list_files`, `read_file`
- `web_search` tries Tavily → Exa → SearXNG (`agent/search.ts`). Errors and 8 s timeouts fall through to the next one; a used-up quota (Tavily 432/433, Exa 402) is skipped until the 1st of next month. Keys: Settings › Tools, stored in the Keychain (service "Harness"). Per-service monthly counts show there too
- `list_files` / `read_file`: Settings › Tools › File access is Off, One folder (symlinks and `..` can't leave it) or Whole Mac (needs Full Disk Access for Desktop/Documents/Mail). Reads text, code, Word, RTF, ODT and PDF. Private files (SSH keys, cloud and AI-tool credentials, shell startup and history files, `.env`, key and cert files, Keychain, browser and password-manager data; full list in `server/src/agent/secrets.ts`) are read only after you click Allow in the reply; once one is read, web requests in that reply ask too. Files read show as chips that open in the source sheet
- SearXNG runs from source (no Docker): run `server/scripts/setup-searxng.sh` once. The server starts it on demand and stops it after 10 idle minutes
- `fetch_page` uses Readability for the main text (8,000 characters max) and refuses localhost / private-network URLs, including names that resolve to them. Fetched pages show as source chips that open in the browser
- Each call and result shows under the reply ("Used N tools") and is saved with the message

## Requirements

- bun, uv, Rust (`rustup`), Xcode command line tools
- Models are fetched on first load (9B ~6 GB, its MTP drafter 0.14 GB, 4B ~3 GB). To pre-download:
  `HF_XET_HIGH_PERFORMANCE=1 uvx --from huggingface_hub hf download mlx-community/Qwen3.5-9B-4bit` (same for `Qwen3.5-9B-MTP-4bit`, `Qwen3.5-4B-4bit`)

## Run in dev

```sh
cd harness
bun install
bun run dev
```

This runs the server with `--watch` on 127.0.0.1:8787 and `tauri dev` (Vite on :1420) side by side. In dev the Rust shell does *not* spawn the sidecar; the watched server is used instead. The UI also works in a normal browser at http://localhost:1420.

Server alone: `cd server && bun run dev`.

## Build the .app

```sh
cd harness
bun run build
```

This compiles the server to `app/src-tauri/binaries/harness-server-aarch64-apple-darwin`, then runs `tauri build`. Output: `app/src-tauri/target/release/bundle/macos/Harness.app`. Drag it to /Applications.

On quit, the app writes `shutdown` to the sidecar's stdin; the sidecar kills `mlx_vlm.server` and exits.

## Config

Env vars, read from `server/.env` in dev or `~/Library/Application Support/harness/.env` for the built app (see `server/.env.example`):

| Var | Default |
| --- | --- |
| `IDLE_MINUTES` | `30` (0 = never) |
| `THINKING_BUDGET` | `1024` (0 = no cap) |
| `HARNESS_PORT` | `8787` |
| `MLX_PORT` | `8080` |
| `MLX_VLM_SPEC` | `mlx-vlm==0.7.11` (run with `uv tool run --from`) |
| `UV_BIN` | auto-detected (`~/.local/bin/uv`, Homebrew, PATH) |

Idle minutes and thinking budget can also be changed in the app (Settings); those are saved in SQLite and override the env defaults.

Models: edit `DEFAULT_PRESETS` in `server/src/config.ts`, or put a `models.json` with the same shape in `~/Library/Application Support/harness/` (the first entry is the default):

```json
[{ "id": "qwen3.5-9b-mtp", "label": "Qwen3.5-9B + MTP", "model": "mlx-community/Qwen3.5-9B-4bit",
   "draftModel": "mlx-community/Qwen3.5-9B-MTP-4bit", "draftKind": "mtp" }]
```

## Differences from the design canvas

- Traffic lights are the real macOS ones (overlay title bar), not drawn. Their position comes from `trafficLightPosition`.
- The window background is real vibrancy (NSVisualEffectView, Sidebar material), so the canvas's blurred colour blobs behind the glass don't exist. What shows through is the desktop.
- Model names come from config presets ("Qwen3.5-9B + MTP"), not the canvas's shortened labels.
- Settings is a sheet inside the chat window, not a separate System Settings-style window. Controls are HTML styled like macOS, because native AppKit control overlays were laggy and faded oddly.
- The system font (SF Pro / SF Mono) is used instead of the canvas's Geist fallback.
- Source preview doesn't show the note's date line under the title, because the file endpoint returns no modified time yet.
- Code highlighting follows the canvas colours only for keywords, strings, numbers and comments. Light-mode colours are Xcode-style equivalents, since the canvas is dark only.
- The mic button is disabled until the voice milestone. Tool rows and source chips only appear once Milestone 2 sends tool/source events.
