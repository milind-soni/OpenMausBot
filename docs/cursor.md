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

3. Confirm `cursor-agent --version` works. The binary installs to `~/.local/bin` by
   default; OpenMausBot already looks there when launched from a GUI.

The engine stays unavailable until the `cursor-agent` executable is on PATH. A
missing login shows as unauthenticated rather than crashing the fleet.

## Models

The picker starts from a small static catalog and refreshes from plain
`cursor-agent models` output (`slug - Label`, with `(default)` / `(current)` markers).
Live ids are merged into the main cloud rail (not the local-models pane). A
failed listing keeps the last usable catalog (then the static fallback) rather
than emptying the rail.

`--model <id>` is passed as a global CLI flag before `acp`. When the running
CLI also implements ACP `session/set_model`, OpenMausBot pins the same id over
the wire. If that method is missing (`-32601`), the argv pin is left to stand
and the turn continues.

## Autonomy

For compatibility with direct driver embedders, an instance `fullAuto: true`
adds `--force` (the CLI's documented auto-approve switch) only when a turn
does not provide a bot approval level. OpenMausBot app turns always provide
one: both **Ask for approval** and **Approve for me** launch Cursor without
`--force`, then OpenMausBot handles its permission requests according to the
bot's current level.

## What this driver does not do yet

- Cursor ACP extension methods (`cursor/ask_question`, `cursor/create_plan`,
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
