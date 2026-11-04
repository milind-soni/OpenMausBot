# Musterd MCP server

The Musterd desktop app includes a local stdio MCP server. It lets another MCP client
(Kepler, Cursor, Hermes, Claude Desktop) coordinate your Musterd team while the
desktop app and its harness are running.

Legacy OpenMausBot env names (`OPENMAUSBOT_*`, `OMB_*`) still work as aliases.

## What it can do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle bot to an exact available model;
- post and read **Kepler handoffs** (`kepler_notify` / `kepler_inbox`) for Musterd → Kepler outbound notify.

The v1 server intentionally cannot approve requests, remember permission grants, delete data, import teams,
change credentials, or control computer/VM lifecycle. Those actions stay in the human-facing app.

## Kepler (recommended inbound)

With Musterd running on port 8799, point Kepler / Cursor MCP at the source checkout:

```json
{
  "mcpServers": {
    "musterd": {
      "command": "pnpm",
      "args": ["--dir", "C:/Users/prash/Documents/src/Musterd", "mcp"],
      "env": {
        "MUSTERD_PORT": "8799",
        "MUSTERD_TOKEN": "omb_sess_..."
      }
    }
  }
}
```

Outbound (bot → Kepler): set `MUSTERD_KEPLER_TASK_ID` on the Musterd process to the Kepler task id
(e.g. `task:…`). Handoffs land under `~/.musterd/peers/kepler/` (`inbox.jsonl` + per-id JSON + optional task note).

## From the musterd / openmausbot command

```json
{
  "mcpServers": {
    "musterd": { "command": "pnpm", "args": ["musterd", "mcp"], "env": { "MUSTERD_PORT": "8799" } }
  }
}
```

The same operations are also commands of their own, for scripts and CI:
[docs/headless-cli.md](headless-cli.md).

## From a source checkout

Start Musterd, then configure the MCP client:

```json
{
  "mcpServers": {
    "musterd": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/Musterd", "mcp"]
    }
  }
}
```

Packaged desktop builds require a paired session for tools that create,
change, send, switch, interrupt, or run anything. Read-only tools work on
loopback without one. To authorize an external MCP client:

1. In Musterd, open **Settings → Phone → Set up a phone** and reveal the
   one-time pairing code.
2. Exchange it locally (remove spaces from the displayed code):

   ```sh
   curl -X POST http://127.0.0.1:8799/api/auth/pair \
     -H 'content-type: application/json' \
     --data '{"code":"YOUR-CODE","label":"Kepler MCP"}'
   ```

3. Pin that same port and token:

   ```json
   "env": {
     "MUSTERD_PORT": "8799",
     "MUSTERD_TOKEN": "omb_sess_..."
   }
   ```

## Product edition

Default `MUSTERD_EDITION=local` loads a slim driver set and skips HighLevel / Postiz / phone routes.
Set `MUSTERD_EDITION=full` for upstream-parity engines and vertical routes.

Data directory defaults to `~/.musterd` (copy-migrated from `~/.openmausbot` on first start).
Override with `MUSTERD_DATA_DIR` or legacy `OMB_DATA_DIR`.
