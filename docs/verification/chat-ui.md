# Chat UI, driven headlessly

The `ui` group of `control-omb` drives the real React renderer — the same
`<App/>` the desktop shell loads, mounted by `scripts/testing/threads-preview.tsx`
— in a headless Chrome through the agent-browser binary the harness pins
(`server/browser-engine-release.ts`, implementation in
`scripts/testing/control-omb-ui.ts`). Everything it touches is disposable: the
fake-engine fixture from `launch`, a Vite preview of the app, and one browser
session whose `HOME` is the fixture's data directory. The user's app on port
8799 and `~/.openmausbot` are never involved.

## Launch

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch \
  --tool-calls '[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]'
```

Run it in the foreground so Ctrl-C reaches it. On first use it downloads the
pinned agent-browser release (size and SHA-256 verified) and its Chrome for
Testing into `.omb-scratch/verify-tools` (gitignored); later launches reuse
them. `OMB_AGENT_BROWSER_PATH` and `AGENT_BROWSER_EXECUTABLE_PATH` take
precedence when set. The launcher then starts the fixture, pins its language
to English (`PATCH /api/config`), creates Pepper through the same `new-bot`
path as [Chat turns](chat-turns.md), mounts the preview, opens it in a headless
session named `omb-ui-<port>`, and prints a handle:

```json
{
  "ok": true,
  "ui": "/tmp/openmausbot-verify-data-XXXXXX/ui.json",
  "url": "http://127.0.0.1:PORT",
  "previewUrl": "http://127.0.0.1:5178/__threads.html",
  "botId": "…", "dataDir": "…", "logPath": "…"
}
```

`--tool-calls` and `--mode` script the fake engine (`FAKE_CLAUDE_TOOL_CALLS`
and `FAKE_CLAUDE_MODE` in `server/testing/fake-claude-cli.ts`). Pass `ui.json`
to every other verb as `--ui`; there is no discovery, so a recipe cannot drive
a browser it did not launch.

## Drive

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
pnpm control:omb ui flag --ui $H --set features.showToolCalls=true --dry-run
pnpm control:omb ui flag --ui $H --set features.showToolCalls=true
pnpm control:omb ui snapshot --ui $H --interactive
pnpm control:omb ui type --ui $H --name "Message Pepper" --text hello
pnpm control:omb ui press --ui $H --keys Enter
pnpm control:omb ui wait-settle --ui $H --timeout 60
pnpm control:omb ui snapshot --ui $H
pnpm control:omb ui click --ui $H --name "Save as skill"
pnpm control:omb ui eval --ui $H --js "document.querySelector('textarea[aria-label=\"Message Pepper\"]').value"
```

`snapshot` returns the accessibility tree with `@eN` refs and a `refs` table
of accessible names and roles. `click` and `type` take `--ref @eN` or the
exact `--name`, and refuse an ambiguous name by listing the candidates. `flag`
patches server feature flags (`PATCH /api/config` with `features`); the
renderer picks the change up over SSE. `wait-settle` succeeds only when the
shared `wait` tool reports the seeded bot settled, no bot in `GET /api/bots`
is busy, the transcript shows the newest server message (its `data-mid` row)
and the browser reports network idle; on timeout it exits non-zero with the
last state it saw.

Expected: the interactive snapshot has exactly one `textbox "Message Pepper"`.
After the turn, the `log "Conversation with Pepper"` landmark contains
`StaticText "hello"`, a `StaticText "Bash"` tool chip (the scripted call) and
`StaticText "hello from fake claude"` (the fake engine's reply). The chip is
present only because `showToolCalls` is on; the sidebar row previews the reply
too, so read the transcript landmark, not the whole tree.

## Evidence

```sh
pnpm control:omb ui screenshot --ui $H --out .omb-scratch/verify-evidence/chat-ui.png
pnpm control:omb ui console --ui $H
pnpm control:omb ui eval --ui $H --js "document.title"
```

Keep the `wait-settle` JSON, both snapshots, the screenshot and the printed
server log path. The console output must contain no `error` entries.

What the screenshot looks like when the recipe passes (`evidence/chat-ui/chat-ui.png`):

![The isolated app after the recipe: Pepper's greeting, the sent "hello", a passed Bash chip and the fake reply](evidence/chat-ui/chat-ui.png)

The permanent form of this recipe is `scripts/testing/control-omb-ui.e2e.test.ts`:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/control-omb-ui.e2e.test.ts
```

The asserted recipe now also covers the floating **This run** card with a
successful, failed, and dry-run command. The card records every shell command
the bot ran in the current ask — the commands after the person's last message —
and marks the ones that went through the control CLI **verified**; reads
(`cat`, `git log`, `gh pr view`, a `curl` that only fetches) and computer-use
are left out, and a run of one unverified command shows no card. Those tool
outcomes are **simulated provider events**, not executions of the commands
written in the chips; the card's summary reads `3 steps · 3 verified · 1 failed
· 1 dry run`. The recipe then presses **Save as skill**, which fills the
composer in one of two shapes. A run with a verified step opens with the
trigger phrase (`Create a verification skill from the run below.`), then
`Goal: hello` (the person's request), the rule not to re-run, and one line per
step with the verified ones tagged `(verified)`. A run with no verified step
asks in plain words instead — `Save the steps below as a reusable skill for my
review.`, then `Goal: <request>`, then "Keep the exact commands and note the
failed ones as gotchas. Do not re-run anything.", then the step lines; the
server (`server/skill-learn.ts`) expands a turn that opens with that sentence
into the same skill-authoring turn as `/learn`, so nobody sees or types a slash
command. In both shapes the caret is in the composer and no new user message
was sent — the transcript still holds exactly one `StaticText "hello"`. The person adds any notes and
sends as usual; the card never sends on its own. Separately, the recipe runs a
real fixture health check and verifies that clicking a deliberately missing
control fails. The card remains collapsible; the old execution timeline is no
longer shown above chat.

For activity detail, click **Inspector → Run Log**. It shows the selected
conversation's recorded commands, statuses and timestamps; command previews
may be shortened. **Events** and **Raw** retain the underlying technical views.
The recipe checks tab switching and saves `run-log.png` alongside `chat-ui.png`.
**Copy redacted run log** copies only the displayed activity (up to 200 entries),
not chat text or raw protocol data. Review copied logs before sharing: automatic
redaction is best effort. Neither this log nor a successful command proves an
unasserted user outcome.

It runs when an agent-browser binary resolves and is skipped with a printed
reason otherwise; `OMB_UI_E2E=1` forces the verified download. The `ui-smoke`
job in `.github/workflows/ci.yml` runs it on Ubuntu 24.04 and uploads the
screenshot; it is not one of the required checks.

## Paused-frame stream buffering

`scripts/testing/stream-buffer.e2e.test.ts` launches the same isolated server,
Vite and disposable browser session, mounting the real `StoreProvider` with a
fixture-only text/reasoning probe. It pauses `requestAnimationFrame`, sends
through the shared control surface, and holds the fake CLI's final frames
until both intermediate channels reach the renderer. After settlement it
asserts exactly one complete reply and empty stream channels, including after
the fallback timer could fire. This probes state; the current app's active-turn
tail displays presence rather than partial text/reasoning.

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/stream-buffer.e2e.test.ts
pnpm exec vitest run src/state/store.test.ts
```

Only the **pending buffer** is drained: once per frame, after 100ms when timers
run, or at 64 × 1024 UTF-16 characters (not bytes). The size test also pauses
timers and proves an oversized chunk is flushed intact. Total accumulated
output is intentionally unbounded; no output is truncated and this is not a
hard memory cap. Fully suspended browser execution cannot run either callback.
The fixture prints a persistent `.stream.json` evidence path after closing its
browser and server and removing its temporary data.

## Bot setup and MCP access recipe

`scripts/testing/bot-tools-ui.e2e.test.ts` uses the same full-app launcher and
optional `OMB_UI_E2E=1` gate. It verifies profile-only role creation, closing
and reopening the dialog during a slow creation without duplicate submissions, recovery
when the preset PATCH fails after creation, the composer’s Tools shortcut,
optional setup ideas, Paste config importing disabled servers, refreshed
per-bot MCP switches and saved opt-outs, and modal Tab/Escape containment.
The MCP command is an inert fixture command; no real accounts are connected.
The advisory renderer job runs both recipes. Runtime mounting, direct/channel
turns, busy-state rejection and revoked-session imports are separately exercised
by `server/mcp-selection.e2e.test.ts` against disposable fake-engine servers.

## Cleanup

Interrupt `ui launch` with Ctrl-C. It closes the browser session (waiting
until agent-browser no longer lists it), then the preview, then the fixture,
and removes only its data directory; the server log stays at the printed path
and the tools directory keeps the downloads. Every verb refuses a handle whose
launch has stopped.

## What this proves, and what it does not

Proven: the real composer sends a turn on Enter, the fixture runs the scripted
fake-engine turn, the transcript renders the sent text, the tool chip and the
reply, a server-side feature flag reaches the renderer live, and Save as skill
fills the composer without sending — all in a Chromium page, through
accessibility names, with no mouse coordinates.

Not proven: the Electron shell (menus, preload bridge, screen capture,
dictation), a real provider, Settings, sidebar drag-and-drop, the VM modal, the
browser panel and updater UI, and anything `Show threads` gates (that toggle is
renderer localStorage, outside `ui flag`). `AGENT_BROWSER_HEADLESS=1` is set
for consistency with the harness, but agent-browser 0.37.0 is headless by
default and reads `AGENT_BROWSER_HEADED` to opt out.
