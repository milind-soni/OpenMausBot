# OpenConnector

Open **Plugins** and find **OpenConnector** beside Postiz and the other apps. OpenConnector is the
self-hosted app catalog: a single program on this computer serves a Streamable HTTP MCP endpoint with
five tools — `list_apps`, `search_actions`, `get_action_guide`, `execute_action` and `list_connections` —
covering 1,600+ services (Gmail, GitHub, Slack, Notion, X, …). Connecting it here gives your bots those
tools, as an ordinary MCP server named `openconnector`, without Composio or any cloud broker in the
loop.

**Connect** saves two settings:

- **Address** — where OpenConnector serves MCP. The default `http://127.0.0.1:3000/mcp` matches a
  standard single-file install; change the port here if you started it with another one.
- **Program** — what OpenMausBot starts it with. The default `openconnector` resolves the official
  single-file binary on your `PATH`. Leave it empty when you run OpenConnector yourself (a service
  manager, Docker, another machine over https) and OpenMausBot only connects, never touches the process.

With a program saved, OpenMausBot manages the process: it starts OpenConnector on demand, adopts one
that is already running (including across an OpenMausBot restart), health-checks the endpoint every 30
seconds, restarts it after a crash — at most three consecutive attempts, then the card rests in an error
state until you reconnect — and stops it on **Disconnect**. The started process is a detached daemon:
quitting OpenMausBot does not take it down. A record of the pid OpenMausBot started lives in
`<data>/openconnector-process.json` (owner-only) so a later run can find and stop the right process.

Which bots get the tools follows the usual MCP rules: every bot set to use every enabled server gets
`openconnector`, and a bot with its own selection must name it under **Tools → Access → MCP servers**.
Like every custom server, its calls go through the engine's own approval flow — nothing is pre-approved.

Limits and notes:

- OpenConnector takes no credentials of its own; app connections you set up inside OpenConnector are
  managed by OpenConnector. An OpenConnector address that tries to carry a user name, password, query or
  key in the path is refused.
- When OpenMausBot manages the process, the address must be on this computer (`127.0.0.1`,
  `localhost`, `::1`). Plain `http://` off this computer is refused everywhere; use `https://` for a
  remote one. Managed process and plain-http loopback are desktop/self-hosted only — the card stays off
  a Team Cloud.
- The organization MCP policy applies to the `openconnector` server like any other; a refused card says
  so under **Blocked**.
- If a server named `openconnector` already exists under **MCP servers**, the card says **taken** and
  leaves that server alone; remove it there to connect from the card.
- In `config.json` the card's settings live under `openconnector` (`url`, `command`, `args`); the
  connection itself is the `mcpServers.openconnector` entry, editable and removable there like any
  server's. `OMB_OPENCONNECTOR_URL` and `OMB_OPENCONNECTOR_COMMAND` set the same two fields from the
  environment.

Get the single-file binary from the [OpenConnector releases](https://openconnector.dev); OpenMausBot
does not download or bundle it.
