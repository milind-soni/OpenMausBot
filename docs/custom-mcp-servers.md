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

Tokens for URL servers go in headers, never in the address.

### Servers that ask you to sign in

Some URL servers take no token; they want you to sign in with your browser
(OAuth). When **Test** gets an HTTP 401 that points to the server's sign-in
details (RFC 9728 protected-resource metadata, then the authorization
server's own metadata), the server shows **Needs sign-in** and a **Sign in**
button. Sign in opens the provider's page in your browser, which returns to
OpenMausBot on `127.0.0.1`. The server then shows **Signed in**, and Test
lists its tools.

- **Which servers work.** The authorization server must support PKCE with
  S256. If it lets apps register themselves (dynamic client registration),
  OpenMausBot registers a fresh app for each sign-in. If it only accepts an
  app registered in advance, add that app as described below. A 401 without
  sign-in details keeps the old message: check the address and headers.
- **Where you can sign in.** On the workspace computer or from another
  device using the redirect URL paste-back flow described below.
- **Bots never sign in.** A server that needs sign-in is left out of every
  turn until someone signs in from this page. A signed-in server gets
  `Authorization: Bearer …` in place of any `Authorization` header you set,
  so every engine that reaches URL servers can use it.
- **Tokens are kept apart.** They live in `~/.openmausbot/mcp-oauth.json`
  (owner-only), never in `config.json` or an API response, and are left out of
  workspace backups. They belong to the server's address: changing the
  address or removing the server drops them. **Sign out** revokes them when
  the server offers that, then forgets them.
- **Refresh.** A token is refreshed shortly before it expires. If the server
  refuses the refresh, the server goes back to **Needs sign-in**.

For a headless or remote workspace (including an SSH tunnel), open **Signing
in from another computer?** while sign-in is waiting. Finish approval in your
browser. If it redirects to a localhost page that cannot connect, copy the
**entire URL from the address bar**, paste it into **Redirect URL**, and choose
**Complete sign-in**. The connection error is expected: that address refers to
your computer, while OpenMausBot is on the server. No extra port forwarding or
public callback address is needed. **Open sign-in page** reopens the approval
page if your browser blocked the first attempt.

Keep the redirect URL private. Complete the flow in the same OMB browser/session
that started it, within five minutes. Cancellation or logging out ends the
pending flow; a URL cannot be reused. Existing same-machine sign-in still
finishes automatically. This works with dynamically registered and
pre-registered sign-in apps.

#### Servers that need an app registered in advance

Corporate identity providers (Microsoft Entra ID, for example) and some
hosted servers do not let apps register themselves. Register an app with the
provider, then edit the server and fill in **Sign-in app**:

- **Client ID** of that app. With a client ID set, OpenMausBot signs in as
  that app and never registers one.
- **Client secret**, only for a confidential app. It is write-only like a
  header value: kept in `config.json`, never shown again, and sent only to
  the authorization server's token endpoint (HTTP Basic, or in the form when
  the server lists only `client_secret_post`). It is never copied into
  `mcp-oauth.json`. Leave it blank to keep the saved one; **Remove saved
  secret** drops it.
- **Scopes**, separated by spaces. They replace the scopes the server
  advertises; add `offline_access` when your provider needs it to issue a
  refresh token.

After you save, the editor shows the redirect URI to register with the app:
`http://127.0.0.1:<port>/mcp-oauth/callback`, where the port is fixed for
the server's address. Sign-in with a registered app always uses that port; if
another program holds it, sign-in stops and says so. Changing the client ID
or the scopes signs the server out; a new secret for the same app does not.

### Example: give your bots web search

A good first URL server is You.com's search server, because the free profile
needs no token at all. Add a URL server with the address

```
https://api.you.com/mcp?profile=free
```

leave the headers empty, and press **Test** — the handshake completes and the
server advertises `you-search` (web search) and `you-discover` (a directory of
other MCP servers). The free profile is read-only and rate-limited to 100
searches a day; there is no key, so none is stored. Turn the server on and
every compatible bot can search the web on its next task — `you-search` results
arrive like any other tool result, through the approval cards.

If the free limits are too small, [you.com/platform](https://you.com/platform)
issues an API key with a higher quota and extra tools (`you-contents` for
full-page extraction, `you-research` for multi-step reports). Add the same
address without `?profile=free` and one header line,
`Authorization: Bearer <your key>` — the key is kept write-only like every
other header value.

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

## When your organization manages MCP servers

If this computer is connected to an organization (Settings → Organization)
and its Admin turns off custom MCP servers, only servers whose name or address
is on the organization's approved list reach bots. Other configured servers
stay in your list, marked **Managed by** your organization, but bots do not
get them, and the "Also use my Claude Code MCP servers" switch has no effect.
**Paste config** is off, and **Add server** accepts only approved servers.
Nothing is written to `config.json`; disconnecting the organization restores
the list as you configured it. With no organization connection, none of this
applies.

Address entries are HTTPS only. The host is compared label by label, where
`*` stands for one or more whole labels (`https://*.example.com/mcp` matches
`https://a.example.com/mcp`, never `https://evil.test/x.example.com/mcp`),
and the path separately, where `*` matches anything.

Limits: a personal **Codex** engine also loads MCP servers from your own
`~/.codex/config.toml`, which OpenMausBot does not filter. An organization that
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
    },
    "corp": {
      "type": "http",
      "url": "https://mcp.corp.example/mcp",
      "oauth": { "clientId": "…", "clientSecret": "…", "scopes": ["api://corp-mcp/read", "offline_access"] }
    }
  },
  "features": { "claudeUserMcp": false }
}
```

`type` is `http` (Streamable HTTP, the default) or `sse`. `oauth` is the
optional sign-in app; `clientSecret` and `scopes` may be left out. If you edit the file
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
