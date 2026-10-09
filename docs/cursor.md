# Cursor Agent CLI

Cursor is an optional OpenMausBot engine. OpenMausBot runs the official
[`cursor-agent` CLI](https://cursor.com/docs/cli) in ACP stdio mode (`cursor-agent acp`), so
sessions, streaming, coding tools, permission requests, MCP integrations,
resume, and cancellation use the same runtime as the other ACP engines.

Bots on this engine consume the user's Cursor subscription (or a
`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`), not a separate Anthropic/OpenAI/xAI
key.

## Setup

1. Install Cursor CLI:

   ```sh
   curl https://cursor.com/install -fsS | bash   # macOS / Linux
   ```

   Windows (native): `irm 'https://cursor.com/install?win32=true' | iex`

2. Sign in with `cursor-agent login`, or set `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`
   in the environment of the Cursor instance.

3. Confirm `cursor-agent --version` works. Cursor's docs call the command `agent`;
   the installer adds `cursor-agent` beside it, and OpenMausBot runs that name,
   because other tools also install an `agent`. The binary installs to
   `~/.local/bin` by default (`%LOCALAPPDATA%\cursor-agent` on Windows);
   OpenMausBot already looks in both, so a CLI installed while the app is open
   is found without restarting.

The engine stays unavailable until the `cursor-agent` executable is found. A
missing login shows as unauthenticated rather than crashing the fleet.

## Models

The picker starts from a small static catalog and refreshes from plain
`cursor-agent models` output (`slug - Label`, with `(default)` / `(current)` markers).
Live ids are merged into the main cloud rail (not the local-models pane). A
failed listing keeps the last usable catalog (then the static fallback) rather
than emptying the rail.

`--model <id>` is passed as a global CLI flag before `acp`. Current CLIs
(checked with 2026.09.28) ignore that flag in ACP sessions: every session
starts on `default[]` (Auto). The pick only lands through ACP
`session/set_model`, which accepts only the parameterised ids the session
advertises, such as `grok-4.7[context=256k,reasoning_effort=high,fast=true]`.
OpenMausBot maps the picker slug onto that list: `auto` to `default[]`, a
plain slug to its Standard variant, `-fast` to `fast=true`, and an effort
slug such as `grok-4.7-high-fast` to the variant with that effort. The
session advertises one variant per base, so a slug with another effort
(`grok-4.7-medium-fast`) gets that variant and a notice in the conversation.

If `session/set_model` is missing (`-32601`), the argv pin is left to stand
and the turn continues. If Cursor refuses the id (`-32602`), the turn also
continues, on the model the session started with, and the conversation shows
a notice that names it.

## Autonomy

For compatibility with direct driver embedders, an instance `fullAuto: true`
adds `--force` (the CLI's documented auto-approve switch) only when a turn
does not provide a bot approval level. OpenMausBot app turns always provide
one: both **Ask for approval** and **Approve for me** launch Cursor without
`--force`, then OpenMausBot handles its permission requests according to the
bot's current level.

## Questions

Cursor's AskQuestion tool sends `cursor/ask_question`. OpenMausBot shows all
of its questions on one question card, including multi-select questions, and
answers with the option ids the person picked. Cursor's reply format has no
free text. If any answer is in the person's own words, OpenMausBot replies
`skipped` and puts every answer in the reason, which Cursor gives the model
as it is. An unanswered card replies `cancelled`. A question that arrives as
one `session/request_permission` per question (Cursor's fallback) still
becomes the one-question card it was before.

## What this driver does not do yet

- The other Cursor ACP extension methods (`cursor/create_plan`,
  todos/tasks/images) are not given a dedicated UI. Unknown JSON-RPC requests
  are rejected with method-not-found so the CLI is not left blocked.
- MCP servers passed in `session/new` follow Cursor's ACP limitations; prefer
  project or user `.cursor/mcp.json` where needed.
- Live smoke (`cursor-agent login`, `cursor-agent models`, one real turn) should be run on
  a machine with the CLI installed and signed in before relying on this in
  production.

## Testing

Normal unit and ACP protocol tests use the scripted fake CLI and do not
require a Cursor subscription. Do not print credentials or upload native
protocol logs from a credentialed live run.
