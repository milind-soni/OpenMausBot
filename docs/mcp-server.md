# OpenMausBot MCP server

The OpenMausBot desktop app includes a local stdio MCP server. It lets another MCP client coordinate your
OpenMausBot team while the desktop app and its harness are running.

## What it can do

- list bots and channels, including their active task and current activity;
- read bounded transcript pages and search local transcripts without returning screenshot pixels;
- create and safely edit bot profiles, channels, and separate task conversations;
- send work to a bot or channel, wait for either conversation to settle or need help, and interrupt its active turn;
- list configured model instances and switch an idle bot to an exact available model.

The v1 server intentionally cannot approve requests, remember permission grants, delete data, import teams,
change credentials, or control computer/VM lifecycle. Those actions stay in the human-facing app.

## From a source checkout

Start OpenMausBot, then configure the MCP client to run:

```json
{
  "mcpServers": {
    "openmausbot": {
      "command": "pnpm",
      "args": ["--dir", "/absolute/path/to/OpenMausBot", "mcp"]
    }
  }
}
```

Packaged desktop builds require a paired session for tools that create,
change, send, switch, interrupt, or run anything. Read-only tools work on
loopback without one. To authorize an external MCP client:

1. In OpenMausBot, open **Settings → Phone → Set up a phone** and reveal the
   one-time pairing code.
2. Exchange it locally (remove spaces from the displayed code):

   ```sh
   curl -X POST http://127.0.0.1:8799/api/auth/pair \
     -H 'content-type: application/json' \
     --data '{"code":"YOUR-CODE","label":"Local MCP client"}'
   ```

   If the desktop selected a fallback port, replace `8799` with the port shown
   in Settings. Copy the returned `token`; the pairing code is single-use.
3. Pin that same port and token in the MCP configuration:

   ```json
   "env": {
     "ELECTRON_RUN_AS_NODE": "1",
     "OMB_PORT": "8799",
     "OPENMAUSBOT_TOKEN": "omb_sess_..."
   }
   ```

The paired client appears with phones under **Settings → Phone** and can be
revoked there. Do not share the token or commit it to a repository.

## From the installed desktop app

Release builds bundle `server/mcp-server.js` and can run it with Electron's embedded Node runtime, so users do
not need Node.js or pnpm installed.

macOS example:

```json
{
  "mcpServers": {
    "openmausbot": {
      "command": "/Applications/OpenMausBot.app/Contents/MacOS/OpenMausBot",
      "args": ["/Applications/OpenMausBot.app/Contents/Resources/server/mcp-server.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

On Windows, use the installed `OpenMausBot.exe` as `command`, the adjacent
`resources\\server\\mcp-server.js` as the argument, and the same `ELECTRON_RUN_AS_NODE=1` environment value.
The usual per-user install is under `%LOCALAPPDATA%\\Programs\\OpenMausBot`.

On Ubuntu `.deb` installs, the executable is normally `/opt/OpenMausBot/openmausbot` and the script is
`/opt/OpenMausBot/resources/server/mcp-server.js`. Use the same environment value.

## Connection discovery

With no configuration, the MCP process probes OpenMausBot's three desktop ports (`8799`, `18799`, and `28799`)
and accepts only a health response that identifies itself as OpenMausBot. This handles the desktop's normal
fallback when another local process already owns port 8799.

Set `OMB_PORT` to force one local port, or `OPENMAUSBOT_URL` to use an explicit HTTP(S) origin. Cleartext remote
HTTP is rejected unless `ALLOW_INSECURE_HTTP=true`; HTTPS should be used outside loopback. An optional
`OPENMAUSBOT_TOKEN` is sent as a bearer token for authenticated reverse proxies. When a token is set, an
explicit `OPENMAUSBOT_URL` or `OMB_PORT` is required so the credential is never sent while probing unrelated
local ports. `OPENMAUSBOT_MCP_TIMEOUT_MS` can set an HTTP timeout between 1,000 and 120,000 milliseconds.
In packaged builds, `OPENMAUSBOT_TOKEN` is required for mutating tools as
described above; it is not a generic reverse-proxy secret.

## Tools

| Purpose | Tools |
|---|---|
| Inspect | `get_system_health`, `list_bots`, `list_channels`, `get_bot_messages`, `get_channel_messages`, `search_messages`, `list_available_models` |
| Create and organize | `create_bot`, `update_bot_profile`, `create_channel`, `update_channel`, `create_task`, `switch_task`, `rename_task` |
| Run work | `send_bot_message`, `send_channel_message`, `wait_for_conversation`, `interrupt_conversation`, `set_bot_model` |

`wait_for_conversation` returns `settled`, `needs-user`, `failed`, `stalled`, or `timed-out`, along with a
small redacted transcript tail. MCP cancellation is honored while a tool is waiting.

## Safety and data scope

Transcript reads are paged and capped at 200 messages. Search is capped at 100 hits. Screenshot pixels and
permission grant keys are removed from MCP results. Tool schemas reject unknown fields and malformed values,
and model changes are refused while a bot is working.

The harness itself is local-first and normally binds to loopback. If you expose it through a reverse proxy,
authentication and TLS at that proxy are part of your deployment's security boundary.
