# Plan

Where the UI work stands. Visual spec: the "Harness UI" design canvas (claude.ai artifact, files `project/Main.dc.html`, `Settings.dc.html`, `Sheet.dc.html`). Update this file as steps land.

## Step 2: chat screen

### Pass 1: markdown and streaming (done)
- Replies render headings, lists, tables, quotes, links (open in the browser) — `app/src/Markdown.tsx`
- Code blocks: filename/language header, Copy, Shiki highlighting in the canvas colours — `app/src/highlight.ts`
- Streaming: words wash in (blur → sharp); finished blocks drop back to plain markdown; code lines fade in, highlighting once the fence closes

### Pass 2: thinking, tools, scrolling
- [x] Chat follows the stream smoothly; scrolling up stops it and shows "↓ Latest" — `app/src/follow.ts`
- [ ] "Thinking…" shimmers while reasoning; reasoning streams in dimmer text, collapses to "Thought for Ns" when the answer starts
- [ ] "Used N tools" disclosure: rows slide in, spinner, then result and time. Renders whenever `tool_call` / `tool_result` events arrive (none until Milestone 2)

### Pass 3: sources
- [ ] Source chips under answers; clicking one opens a glass sheet on the right with the note, the cited passage highlighted, and Show in Finder (`GET /api/file`, `reveal` command). Nothing sends sources until Milestone 2 tools exist
- [x] "model · tok/s" line under each reply

### Done alongside (UI review)
- AI chat titles: new chats are "Untitled"; after the first reply the model names it and the title washes in
- Copy on messages, Regenerate on the last reply, Retry on errors, Esc stops, type-anywhere focuses the composer
- Fixes: streaming into the wrong chat after switching, new-chat message race, composer covering the last lines, sidebar menu hover/offset, Esc in Settings fields, reopening Settings mid-close

## After step 2
- Step 4: permission sheet component (`Sheet.dc.html`) — asks before tools write or delete files
- Update the design canvas to match what shipped
- List what couldn't be matched from the design
- Remove the leftover Rust dependencies from the native-controls attempt

## Waiting on Milestone 2 (tools)
- Tool trace rows and source chips only show once the agent emits `tool_call`, `tool_result` and `sources` events
