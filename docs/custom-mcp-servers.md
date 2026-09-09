# Bring your own MCP servers

Open **Plugins → MCP servers → Add server** to give your bots tools from a
trusted local MCP server. Add the executable, put each argument on its own
line, and add any environment variables as `KEY=value`.

OpenMausBot saves a new server switched off. Use **Test** to start it briefly,
complete the MCP handshake, and see the tools it advertises. Then turn it on.
It becomes available to compatible bots on their next task; no app restart is
needed.

This first version supports local stdio commands. It deliberately does not
accept remote MCP URLs or shell command strings.

## What a Claude bot sees, and what it no longer sees

A bot on the Claude engine gets the tools and instructions its owner gave it:
the servers above, its integrations (computer, browser, agents, phone), and
its own project's `<cwd>/.mcp.json`. It **no longer inherits this machine's
Claude Code setup** — the MCP servers and claude.ai connectors in your user or
local Claude config, your skills and agents, your hooks, and your personal
`~/.claude/CLAUDE.md`. Those were being mounted into every turn of every bot
(one measured desktop added 407 tools, ~10k tokens per model call) and were
reachable by the bot.

If a bot genuinely depended on a user- or local-scope server, the supported
fix is to add that server here or to the bot project's `.mcp.json`. The escape
hatch back to the old launch is the environment variable
`OMB_CLAUDE_INHERIT_USER_CONFIG=1` on the OpenMausBot process; it restores
everything above, for every Claude bot, until you remove it.

This isolation uses the CLI flags `--strict-mcp-config` (Claude Code 1.0.60+)
and `--setting-sources project` (1.0.122+); the harness also picks the
session's compaction window with `--autocompact` (2.1.122+). OpenMausBot reads
`claude --version` whenever it lists engines (app load, the Engines page, after
an update) and only passes each flag to a CLI that accepts it, so an older CLI
keeps working — without the controls it predates — and the Engines page shows
an update notice with the exact command. `claude update` clears it.

## Advanced: edit the file

The same registry lives in `~/.openmausbot/config.json`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "@example/notes-mcp"],
      "env": { "NOTES_TOKEN": "…" }
    }
  }
}
```

If you edit the file by hand, restart OpenMausBot. Every bot whose engine can
mount custom MCP servers gets the enabled tools on its next task.

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
- **Credentials are write-only in the UI.** The API returns environment names,
  never their values. Leaving an existing value blank keeps it saved; removing
  its line deletes it.
- **Credentials stay off argv.** `env` values travel in the child
  environment (Codex argv carries env *names* only; Claude uses the private
  0600 mcp-config file; ACP passes them in the session payload with the
  wire log redacted). They do persist as plaintext in the 0600 config file —
  prefer tokens scoped to the one server.
- **Testing is bounded.** The test command is stopped after the handshake (or
  eight seconds), its output is capped, and its stderr is never sent to the UI.
  It inherits none of OpenMausBot's workspace or provider credentials; only
  the environment variables configured for that MCP server are added.
- `"enabled": false` parks an entry without deleting it.
- Stdio servers only for now — `url` transports are a planned follow-up and
  are skipped with a note.
