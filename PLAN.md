# Plan

Task board for the Harness UI work. Agents: read this file and `README.md`, then only the files your task lists. Don't re-explore the codebase; the map below is accurate.

## How to use this board

1. Pick one task whose status is `todo` and whose dependencies are done. Set its status to `in progress (<your name/session>)` and save this file before you start.
2. Touch only the files listed for the task. If you must edit a file another `in progress` task lists, keep the change small and mention it in your commit.
3. When done: run the checks below, commit, set status to `done (<commit hash>)`, and add anything the next agent needs to know under the task's notes. Keep notes to a line or two.
4. If you find a new problem, add it as a new task at the bottom instead of fixing it on the side.

## Ground rules

- **bun only** (no npm/yarn). Rust: `export PATH=$HOME/.cargo/bin:$PATH` first; cargo isn't on the default PATH.
- **Don't change backend behaviour that works**: model manager, MTP server, thinking budget, SQLite history. Additive changes (new columns, endpoints, events) are fine.
- **No native AppKit overlays for controls.** Floating NSSlider/NSSwitch over the webview was tried and reverted (laggy, odd fades). Controls are HTML styled like macOS 26.
- Respect `prefers-reduced-motion` (no blur/slide, plain fades or nothing). Every colour goes through the tokens in `app/src/styles.css` so light and dark both work. Accent is `var(--accent)` (system accent, fallback `#0A84FF`).
- Match the design canvas closely: colours, spacing, radii, font sizes, copy.
- **Commits:** small, one task each, imperative subject, short body, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or your model's line). Never push; the user pushes.
- **Checks before committing:**
  - UI: `cd app && bun run vite:build` (runs `tsc --noEmit` + vite)
  - Server: `cd server && bunx tsc --noEmit`
  - Rust: `cd app/src-tauri && cargo check`
- **Seeing it:** `bun run dev` from `harness/` (server with --watch + `tauri dev`). The UI also runs in a browser at http://localhost:1420 (only port 1420 passes CORS). Screenshots: only for visual changes, shrink with `sips -Z 800` before reading.
- **Visual check without the app:** Playwright WebKit is installed (`uvx --from playwright python script.py`). Render a throwaway fixture page under `app/` via `bunx vite --port 1420`, screenshot it, shrink with `sips`, then delete the fixture. This caught a broken CSS selector that typecheck/build can't.
- **Ship:** `bun run build` from `harness/`, then replace `/Applications/Harness.app` with `app/src-tauri/target/release/bundle/macos/Harness.app` and `open` it. Check `curl 127.0.0.1:8787/api/health` returns 200.

## Map

| Path | What |
| --- | --- |
| `app/src/App.tsx` | Main window state: chats, streaming draft, model, settings, menu events, sheet state |
| `app/src/Sidebar.tsx` | Glass sidebar: toggle, new chat, search, Today/Yesterday/Earlier, ⋯ row menu (Rename, Delete), Memory/Settings |
| `app/src/TitleBar.tsx` | Centered model name + glass model menu |
| `app/src/Composer.tsx` | Floating glass composer: Think, mic (disabled), send ↔ stop |
| `app/src/Markdown.tsx` | react-markdown + remark-gfm renderer, streaming word wash-in, code blocks |
| `app/src/highlight.ts` | Shiki (JS regex engine, Xcode-like light/dark themes), cached |
| `app/src/follow.ts` | Auto-follow scrolling + "↓ Latest" pill logic |
| `app/src/SourceSheet.tsx` | Right-hand source preview: note as markdown, cited block highlighted, Show in Finder |
| `app/src/PermissionSheet.tsx` | `askPermission()` + the permission sheet (Deny / Allow Once, always-allow checkbox) |
| `app/src/Reply.tsx` | "Thought for Ns" / "Used N tools" disclosures |
| `app/src/Settings.tsx` | Settings modal (System Settings style); `openSettings(pane)` in `native.ts` opens it |
| `app/src/native.ts` | Tauri wrappers: menu events, model menu sync, accent colour, `openUrl`, `reveal` |
| `app/src/api.ts` | REST + SSE client, types (`Message`, `ToolStep`, `Source`, `SendEvent`) |
| `app/src/styles.css` | All tokens and styles (dark default, light under `prefers-color-scheme`) |
| `app/src-tauri/src/lib.rs` | Window vibrancy, app menu, tray, commands: `set_model_menu`, `accent_color`, `show_main_window`, `open_url`, `reveal` |
| `server/src/index.ts` | Hono API. SSE per message: `user → status* → (reasoning \| content)* → done \| error` |
| `server/src/db.ts` | SQLite: chats, messages (+ `thinking_ms`, `tools`, `sources` JSON), settings, memories |

Useful facts:
- Stream events the UI already types (`api.ts`): `tool_call {id,name,args}`, `tool_result {id,result,ms,error?}`, `sources [{path,title?,quote?}]`. The server doesn't send them until Milestone 2; render them whenever they arrive, fake nothing.
- Saved replies carry `thinking_ms` (reasoning time), `tools` and `sources` (JSON strings, `parseJSON` in `api.ts`).
- `GET /api/file?path=` returns `{path, content}` for `.md/.markdown/.mdx/.txt` under the home folder.
- Design canvas: https://claude.ai/artifact/9KZdtnw5QufE9189MUbEt7. Read files with the Artifact tool (`action: "read"`, `paths: ["project/Main.dc.html", …]`), not WebFetch.

## Done

- Step 1, native shell: vibrancy (Sidebar material), overlay title bar with the traffic lights in the sidebar, app menu, Model menu, tray, accent colour.
- Settings modal: model/idle popups, Think by default, budget slider (glides to ticks), system prompt, Memory list. Saved in SQLite; applies immediately.
- Chat pass 1: markdown, code blocks + Shiki, streaming wash-in, follow-scroll + "↓ Latest", AI chat titles, Copy/Regenerate/Retry, Esc stops.
- Fixes: the built app's server quit on launch (now watches the parent PID).

## Tasks

### T1 Thinking disclosure — status: done (a81ecc2 + reasoning wash-in)
Files: `app/src/Reply.tsx`, `app/src/App.tsx`, `app/src/styles.css`
- While reasoning: "Thinking…" label with a light shimmer; reasoning streams below in dimmer text with the same blur-in as replies.
- When the first answer token arrives: collapse to "Thought for Ns" (live timing in the client; `thinking_ms` for saved replies). Click toggles.
- Saved replies: collapsed by default.
- Done when: works live with Think on, and on reload of an old chat; reduced motion = no shimmer/blur.

### T2 Tool trace disclosure — status: done (a81ecc2; checked with a server-rendered fake trace, nothing committed)
Files: `app/src/Reply.tsx`, `app/src/App.tsx`, `app/src/styles.css`
- "Used N tools" next to "Thought for Ns". Rows: call (mono), result, time. Each row slides/fades in on `tool_call`, shows a small spinner, settles to result + time on `tool_result`.
- Saved replies read `tools`. Nothing renders when there are no tool events.
- Done when: a hand-fed fake event sequence in dev renders correctly (don't commit the fake), and nothing shows in normal chats.

### T3 Source chips + source sheet — status: done (see git log)
Files: new `app/src/SourceSheet.tsx`, `app/src/App.tsx`, `app/src/styles.css`
- Chips under an answer (file icon + file name) from `sources` (live event or saved JSON). Active chip tinted with the accent.
- Clicking opens the right-hand glass sheet (canvas `Main.dc.html`, the `aside` "Source preview"): name + folder, Show in Finder (`reveal`), close. Body renders the file as markdown (`GET /api/file`) with the cited passage highlighted (yellow block like the canvas) and scrolled into view.
- Sheet slides in; Esc or close removes it.
- Done when: works with a fake `sources` event pointing at a real note in dev; reduced motion respected.
- Notes: `SourceSheet.tsx`; highlight = `rehypeCite` in `Markdown.tsx` (marks the block holding the quote, class `cited`). Checked by server-rendering only; give the sheet a visual pass once Milestone 2 sends real sources.

### T4 Permission sheet component — status: done (see git log)
Files: new `app/src/PermissionSheet.tsx`, `app/src/styles.css`
- Reusable component from `Sheet.dc.html`: dims the window, drops from the top, shows the tool name, target path and a diff preview, an "Always allow in this folder" checkbox, Deny / Allow Once (default button, Enter).
- API: `askPermission({ tool, path, diff }) => Promise<{ allow: boolean; always: boolean }>` so the Milestone 2 agent loop can await it before any write/delete.
- Not wired to anything yet. Add a dev-only way to preview it (e.g. `?sheet` in the browser), then remove or gate it before committing.
- Notes: `askPermission(req)` queues requests and renders in its own root (no App wiring). `action: "create" | "edit" | "delete"` picks the copy. Preview: `bun run dev`, open http://localhost:1420/?sheet (gated by `import.meta.env.DEV` in `main.tsx`). Not visually checked yet (no headless browser here).

### T5 Remove leftover native-control deps — status: done (c1d714a): removed objc2, objc2-foundation, serde_json and unused objc2-app-kit features; cargo check passes
Files: `app/src-tauri/Cargo.toml`, `Cargo.lock`
- `objc2-app-kit` only needs `NSColor`, `NSColorSpace`, `objc2-core-foundation` now. Drop the other features; drop `serde_json` and `objc2` if nothing uses them. `cargo check` must pass.

### T6 Update the design canvas — status: done (canvas version 14: Settings drawn as the in-window sheet, Copy/Regenerate under replies; Sheet.dc.html already matched)
- Bring `project/Main.dc.html`, `Settings.dc.html`, `Sheet.dc.html` in line with what shipped (Settings is now a modal in the chat window, not a separate window; HTML controls; sidebar toggle; ⋯ chat menu; message actions). Follow the artifact type's instructions that come back from the read; publish only changed files.

### T7 "Couldn't match the design" list — status: done (68ec98b): README section added
- Add a short section to `README.md`: each item, why (e.g. native traffic lights replace the drawn ones; real vibrancy replaces the mockup's blurred blobs; model labels come from config, so "Qwen3.5-9B + MTP" not "Qwen3.5-9B").

### T8 Ship — status: done (installed; API smoke test passed: think on/off, title gen, settings GET/PUT; UI checks left to user)
- Rebuild, install to /Applications, smoke test: send a message with Think on and off, open Settings (⌘,), change a setting, reopen. Report results to the user.

### T9 App quit during first model load — status: done
- Cause: on start the server SIGTERMed the process group of whatever PID `mlx.pid` held, unchecked. Tauri SIGKILLs the sidecar on quit (stdin "shutdown" doesn't arrive), so the file went stale; a reused PID could be the new app. Fix: only kill if that PID is still a uv/mlx_vlm group leader; the app now SIGTERMs the sidecar before SIGKILL so it cleans up. Verified: decoy PID survives, fake mlx is stopped, cold launch + immediate message loads and replies, quit leaves no mlx_vlm and no PID file.
- Was:
- During T8's first smoke run the harness process died while the model was loading. There was no crash report, and it didn't happen again after a relaunch. The first `POST /api/chats` right after launch also returned an empty body (the server probably wasn't up yet). Reproduce with a cold launch, then send a message right away; check the sidecar parent-PID watch and the stdin "shutdown" handling in `server/src/index.ts`.

## Milestone 2: agent loop + tools

Spec (roadmap doc, "Harness build"): hand-written loop, max-steps cap; tools: web search (SearXNG, native via uv, started on demand, killed after 10 idle min), fetch page as text, calculator, read local files in an allowed folder; show each call in the UI; small tool-calling eval (prompts → expected tool + args). The user reviews each step and must be able to explain the loop, how tool calls are parsed, and what goes into the context each turn.

How it works now: `server/src/agent/tools.ts` defines tools (name, description, JSON schema, `run`). The message endpoint loops up to `MAX_STEPS` (6) model calls; tools are passed as OpenAI `tools`, mlx-vlm's Qwen parser turns `<tool_call>` text into streamed `tool_calls` deltas, `client.ts` stitches them by index. Results go back as `role: "tool"` messages. The last step gets no tools so it must answer. The trace is saved in `messages.tools`; later turns only see final answers, not tool results.

### M2.1 Loop + calculator — status: done (see git log)
- Checked live: single call, two chained calls with Think on, plain chat unchanged. tok/s now = the final step only.

### M2.2 Web search + fetch page — status: done (see git log)
- Chain Tavily → Exa → SearXNG, keys in Keychain, Settings › Tools shows keys/status/counts; trace shows "via". Sources = pages actually fetched (search snippets alone give no chips).
- Known: given a URL, the 9B model sometimes answers from memory instead of calling fetch_page (1 of 3 after tightening the description). M2.4's eval should measure this.

### M2.3 list_files / read_file in a shared folder — status: done (see git log)
- `agent/files.ts`. Folder picked in Settings › Tools (tauri-plugin-dialog; a text field in the browser). Paths resolved with realpath and refused outside the folder; binaries, >1 MB and folders refused; reads page by `start_line` (12k chars per call). File tools are only offered while a folder is set, and the system prompt then says the folder exists (without that the model asked the user instead of looking).
- Access is now Off / One folder / Whole Mac (`filesAccess`). Private files (`agent/secrets.ts`: key/cloud/AI-tool folders, shell rc + history files, .env*, key/cert/tfstate extensions, credential file names, config-like files named *secret/token/key/auth*, Keychain, browsers, password managers, chat apps) are listed with a tag but read only after an inline yes; after one is read, web_search/fetch_page in that reply ask too (`agent/permissions.ts`, `permission` SSE event → `PermissionCard` in the reply → POST /api/permissions/:id; no answer in 5 min or a stopped reply = deny). The modal PermissionSheet stays for future write tools.
- File tools: list_files (one folder), find_files (Spotlight `mdfind -name`, noise filtered), grep_files (ripgrep if installed, else /usr/bin/grep; 15 s cap, 80 matches, private files never searched into), read_file. Local tools are listed before web tools.
- Known: the 9B model still web-searches "where is MAX_STEPS in my harness project" (5 runs out of 5) despite prompt and description guidance; "which projects use hono" and "find my resume" work. M2.4's eval should cover tool choice for local vs web questions.
- read_file also converts Word/RTF/ODT (`textutil`) and PDF (PDFKit via JXA), both built into macOS.
- Sources = files read, so an unneeded read also shows as a chip. No `quote` yet (sheet opens at the top); RAG (M4) can add cited passages. Source sheet now renders only .md as markdown, other files as plain text.

### M2.4 Tool-calling eval — status: deferred (user: do evals at the end)
- ~20 prompts → expected tool + args (and "no tool"), run against each preset, report accuracy.

## Milestone 3: memory

Design (roadmap doc, "Memory design notes"): save/update/delete tools for explicit requests, background extraction later; few memories → all in the system prompt, many → embeddings (M4); rolling summary for long chats; never store secrets.

### M3.1 Memories in context + save/update/delete tools — status: done (see git log)
- `agent/memory.ts`: `memoryPrompt()` adds "[id] fact" lines (newest first, ~4k chars) to every system prompt. `save_memory` takes a list (one fact each; merged facts got clobbered by updates), `update_memory`/`delete_memory` by id. Secret-looking facts are refused server-side. A `memory` SSE event shows "Saved to memory · Undo" under the reply (`MemoryLine.tsx`; PATCH /api/memories/:id for undoing updates).
- Loop: if a step after tools comes back empty, one nudge "(Reply to the user now…)" (4B went silent after update_memory).

### M3.2 Background extraction — status: todo
- After a chat goes idle, a 4B pass extracts durable facts the user stated, compares with existing memories, adds/updates/skips.

### M3.3 Rolling summary for long chats — status: todo
- When the prompt nears the context limit, summarize the oldest messages; keep recent ones verbatim.

## Later milestones (not now)
- **Quick Ask panel** (⌥Space, tauri-nspanel): own milestone. Tray "Quick Ask" just opens the main window for now (TODO in `lib.rs`).
- **Write tools:** call `askPermission` (T4) before any write/delete.
- **Voice:** mic button stays disabled until then.

## Open issues
- The user said the Settings sheet's "fading and rendering" felt off before the native controls were removed. Re-check the open/close animation and glass rendering once T1–T3 land; ask the user what still looks wrong rather than guessing.
