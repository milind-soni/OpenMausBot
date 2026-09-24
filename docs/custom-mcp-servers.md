# Bring your own MCP servers

Open **Plugins → MCP servers → Add server** to give your bots tools from an
MCP server you trust. A server is one of two things:

- **Run a command** — a local stdio server. Add the executable, put each
  argument on its own line, and add any environment variables as `KEY=value`.
- **Connect to a URL** — a remote server. Paste its address and, if it needs
  a token, add it as a header (`Authorization: Bearer …`, one header per
  line). Most servers speak **Streamable HTTP**; pick **SSE** only for an
  older server that documents the `/sse` endpoint.

OpenMausBot saves a new server switched off. Use **Test** to start the command
(or connect to the address), complete the MCP handshake, and see the tools it
advertises. Then turn it on. It becomes available to compatible bots on their
next task; no app restart is needed.

Tokens for URL servers go in headers, never in the address. Remote servers
that only offer an OAuth sign-in (no token) cannot be signed into from a bot's
headless run; use a personal access token or API key the server issues and
put it in the `Authorization` header.

### Import and choose tools per bot

**Paste config** accepts an `mcpServers` JSON block, a server-name map, or a
single named entry — commands and URL servers alike, in the shape Claude Code,
Cursor and Claude Desktop write. Import is all-or-nothing, refuses existing
names, and adds servers switched off—even if the pasted config says enabled.
It does not install, execute or connect to them. Test explicitly, then enable
the servers you trust.

Open a bot’s **Tools → Access → MCP servers** to narrow the enabled global
servers offered to it. Existing bots keep all enabled global servers until you
choose a subset; switching them all off means none. **Use every enabled server**
restores the default, including future additions. Stop all of that bot’s running
turns before changing this selection; the next direct or channel turn gets the
new list. The list does not filter project-local `.mcp.json` files and is not a
shell sandbox. Individual tool approvals depend on the engine and approval mode.

### Which engines reach which servers

| Server | Claude Code bots | Codex bots | ACP bots (Cursor, Grok, Kimi, …) | API-model bots |
| --- | --- | --- | --- | --- |
| Command (stdio) | yes, through the result gate | yes | yes | yes |
| URL, Streamable HTTP | yes | yes | when the agent advertises `http` | not yet |
| URL, SSE | yes | no (Codex has no SSE transport) | when the agent advertises `sse` | not yet |

A server an engine cannot reach is left out of that bot's turn with a note in
the server log; nothing else breaks.

## What a Claude bot sees, and the "Also use my Claude Code MCP servers" switch

A bot on the Claude engine gets the tools and instructions its owner gave it:
the servers above, its integrations (computer, browser, agents, phone), and
its own project's `<cwd>/.mcp.json`. By default it does **not** inherit this
machine's Claude Code setup — the MCP servers and claude.ai connectors in your
user or local Claude config, your skills and agents, your hooks, and your
personal `~/.claude/CLAUDE.md`. Those were being mounted into every turn of
every bot (one measured desktop added 407 tools, ~10k tokens per model call)
and were reachable by the bot. Codex bots, by contrast, have always read the
MCP servers in `~/.codex/config.toml`, which is why the two engines looked
different.

If you want Claude bots to see your own Claude Code MCP servers too, switch on
**Also use my Claude Code MCP servers** at the top of Plugins → MCP servers.
With it on, every Claude bot also loads the servers and connectors from your
Claude Code config on every message; skills, hooks and the personal
`CLAUDE.md` still stay out. More tools means more tokens per message, so keep
it off unless you need those servers — the recommended way to give a bot a
server is still this page or the bot project's `.mcp.json`.

The switch drops the CLI flag `--strict-mcp-config` (Claude Code 1.0.60+)
while keeping `--setting-sources project` (1.0.122+). The environment variable
`OMB_CLAUDE_INHERIT_USER_CONFIG=1` on the OpenMausBot process remains the full
escape hatch back to the old launch: it restores everything, for every Claude
bot, until you remove it. The harness also picks the session's compaction
window with `--autocompact` (2.1.122+). OpenMausBot reads `claude --version`
whenever it lists engines (app load, the Engines page, after an update) and
only passes each flag to a CLI that accepts it, so an older CLI keeps working
— without the controls it predates — and the Engines page shows an update
notice with the exact command. `claude update` clears it.

## When your organisation manages MCP servers

If this computer is connected to an organisation (Settings → Organisation)
and its Admin turns off custom MCP servers, only servers whose name or address
is on the organisation's approved list reach bots. Other configured servers
stay in your list, marked **Managed by** your organisation, but bots do not
get them, and the "Also use my Claude Code MCP servers" switch has no effect.
**Paste config** is off, and **Add server** accepts only approved servers.
Nothing is written to `config.json`; disconnecting the organisation restores
the list as you configured it. With no organisation connection, none of this
applies.

Address entries are HTTPS only. The host is compared label by label, where
`*` stands for one or more whole labels (`https://*.example.com/mcp` matches
`https://a.example.com/mcp`, never `https://evil.test/x.example.com/mcp`),
and the path separately, where `*` matches anything.

Limits: a personal **Codex** engine also loads MCP servers from your own
`~/.codex/config.toml`, which OpenMausBot does not filter. An organisation that
must block those can allow only company models, or leave personal Codex off
its engine list. Company Codex uses its own separate home, without your
`config.toml`.

## Advanced: edit the file

The same registry lives in `~/.openmausbot/config.json`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@example/notes-mcp"],
      "env": { "NOTES_TOKEN": "…" }
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  },
  "features": { "claudeUserMcp": false }
}
```

`type` is `http` (Streamable HTTP, the default) or `sse`. If you edit the file
by hand, restart OpenMausBot. Every bot whose engine can mount custom MCP
servers gets the enabled tools on its next task.

## Rules that keep this safe

- **Permission cards by default.** Custom servers are never pre-approved:
  on Claude their tools route through the permission broker into Allow/Deny
  cards; on Codex they keep the on-request approval policy; ACP engines
  relay the agent's own permission asks. Built-ins stay pre-quieted — only
  *your* servers ask.
- **Reserved names are refused** (`computer`, `agents`, `composio`,
  `browser`, `phone`, `dweb`, `ogb`, …) so a custom entry can never shadow
  a built-in tool surface. Names are lowercase letters/digits/`_`/`-`, max
  32 chars, starting with a letter.
- **One bad entry never takes the fleet down.** Invalid entries are skipped
  with a logged reason; the rest still mount.
- **Credentials are write-only in the UI.** The API returns environment and
  header names, never their values. Leaving an existing value blank keeps it
  saved; removing its line deletes it.
- **Credentials stay off argv.** `env` values travel in the child
  environment (Codex argv carries env *names* only; Claude uses the private
  0600 mcp-config file; ACP passes them in the session payload with the
  wire log redacted). Header values do the same: Codex reads them from
  harness-named environment variables (`env_http_headers`), Claude from the
  0600 file. They do persist as plaintext in the 0600 config file — prefer
  tokens scoped to the one server.
- **Testing is bounded.** A command is stopped after the handshake (or eight
  seconds), its output is capped, and its stderr is never sent to the UI. It
  inherits none of OpenMausBot's workspace or provider credentials; only the
  environment variables configured for that MCP server are added. A URL test
  reads at most 1 MB and reports only the HTTP status of a refusal.
- **Addresses are checked.** A URL server needs a full `http://` or
  `https://` address with no credentials in it; header names must be valid
  HTTP field names and values a single line.
- **The result gate covers commands.** Oversized tool results from a stdio
  server are trimmed before they reach the model (`OMB_MCP_RESULT_BUDGET`).
  A URL server is contacted by the engine itself, so there is no process to
  stand between; its results arrive untrimmed.
- `"enabled": false` parks an entry without deleting it.
