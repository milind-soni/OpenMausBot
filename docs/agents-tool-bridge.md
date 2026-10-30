# Agents tool bridge

Every turn of every bot is sent OpenMausBot's own tool catalog: 27 to 39 tools,
43 to 57 KB of JSON, though most turns call two or three of them. With the
bridge on, a turn is listed a short set of tools it needs in most turns, plus
two more:

- `find_tool({ query })` searches the rest of that turn's tools and returns, for
  the best three matches, the name, the description and the full input schema.
- `use_tool({ name, arguments })` runs one of them. The call goes down the same
  path as a call to the tool by its own name, so the same refusals, limits and
  results apply. Nothing about a tool is checked by `use_tool` that a direct
  call is not checked for.

The list is then 14.5 to 15.4 KB, 65 to 74% smaller. What a turn may call does
not change: the tools behind `use_tool` are exactly the ones the turn would
have been listed.

It is off by default.

## Turning it on

In `~/.openmausbot/config.json`:

```json
{ "features": { "agentsToolBridge": true } }
```

or for one server process, `OMB_AGENTS_TOOL_BRIDGE=1`. The variable wins over
the saved setting when it is exactly `1` or `0`.

## The tools that stay listed

`tool_result_read`, `list_room_targets`, `coordinate_bots`, `list_bots`,
`list_rooms`, `select_computer`, `attach_file`, `post_to_room`,
`request_credential`, `request_sign_in`, `fill_login`, `memory_update`, and
where the bot has them `send_voice_note` and Watcher's `create_options_card`.

Two of these can never be reached through `use_tool`: `post_to_room` and
`send_voice_note`. OpenMausBot recognizes a send by the name of the tool that
made it (so that a turn cut off after posting is not run again), and any tool
it would recognize that way is always listed and answers "call it directly".

## Which bots and engines get it

The switch is necessary, not sufficient. A call made through `use_tool`
reaches OpenMausBot and the engine under the name `use_tool`, so a turn is
bridged only where nothing decides by a tool's own name. The decision is one
function, `agentsToolBridgeRefusal` in `server/agents-bridge-switch.ts`, and
its default is no bridge.

**Bots.** A bot with a [tool selection](tool-selection.md) is never bridged.
Its selection is matched against the name in the call, so it keeps the whole
catalog, as before. This holds even if the selection is saved while a turn is
being set up: wherever a selection is mounted in front of the agents tools,
they are started unbridged (`server/mcp-gate-config.ts`,
`server/drivers/chat-mcp-tools.ts`), and the gate judges a `use_tool` call by
the tool it names as well (`server/mcp-gate.ts`).

**Engines.** Only engines on which OpenMausBot pre-approves all of its own
tools, so that no approval is ever asked for, remembered or refused by one
tool's name, and on which everything the engine itself reads about a tool's
name can be read by OpenMausBot too:

| Engine | Bridged | Why |
|---|---|---|
| Claude Code | Yes, with the exceptions below | The agents server is pre-allowed as a whole (`--allowedTools mcp__agents`, `server/drivers/claude.ts:1673`), and the settings the CLI reads for the turn are checked. |
| API models: OpenAI-compatible, Cerebras, Grok API, Groq, Meta, MiniMax, Mistral | Yes | The chat runtime never asks for the agents server (`server/drivers/chat-mcp-tools.ts:371`) and reads no configuration of the person's about a tool. |
| Codex, including the ChatGPT plan | No | Codex reads a layered configuration of its own: `config.toml` under `CODEX_HOME` or `~/.codex`, a Company engine's own home under OpenMausBot's data, a trusted project's `.codex/config.toml`, `/etc/codex/config.toml` and `/etc/codex/managed_config.toml`; and it has `PreToolUse` and `PermissionRequest` hooks of its own. Any of these can take a rule about a tool by name, and this version does not examine them. |
| Pi | No | pi is launched with `-e` for OpenMausBot's extension and nothing that keeps the person's own extensions out (`server/drivers/pi.ts`, `PI_ARGS`), in the person's home. Pi loads the extensions it finds there, and an extension's `tool_call` handler can block a call by the name it sees, as OpenMausBot's own does (`server/drivers/pi-mcp-extension.ts`). This version does not examine them. |
| ACP agents: Grok, Kimi, Droid, Cursor, Antigravity, OpenCode, Qwen, Hermes, Cline, Gemini, custom | No | They keep their own permissions. "Always allow this session" hands the agent its own remembered approval ([approval levels](approval-levels.md)); given once for a harmless `use_tool` call it would cover every hidden tool. A reviewer would also lose the read-only marks the hidden reads carry, and Grok has native tools named `use_tool` and `search_tool`. |
| Muse Code, and any engine not named above | No | Not shown to qualify. |

If the decision itself fails (a file it reads throws, a record it is handed
cannot be read), the turn runs unbridged, exactly as with the switch off, and
one line is logged naming the kind of error and nothing of what was read.

### Claude Code

Claude Code is not bridged when any of these holds:

- The bot inherits this machine's own Claude Code setup
  (`OMB_CLAUDE_INHERIT_USER_CONFIG=1`, or **Also use my Claude Code MCP
  servers**).
- An entry of the engine's `tools` or `disallowedTools`, which go to the CLI as
  written (`server/drivers/claude.ts:1580-1583`), names the agents server or
  has a wildcard in a tool's name.
- A Claude settings file the CLI will read for the turn names the agents
  server, in its raw text or in any string value or key of what it parses to
  (so a spelling with JSON escapes is seen); or sets a `PreToolUse` or
  `PermissionRequest` hook: a `hooks` key, in any case, holding one of those
  keys, in any case, with any value other than `null`. Any such hook counts,
  whatever it matches: an empty or wildcard matcher sees every call, and a
  hook's own script can test the tool's name. OpenMausBot's own hooks are none
  of these and are in none of these files: it registers `PostToolUse`,
  `PreCompact`, `SessionStart` and `Stop` through a private settings file
  written for each launch.
- A settings file's `permissions.deny` or `permissions.ask` list (keys in any
  case) holds a rule with a wildcard in a tool's name, even one about another
  server (`mcp__github__*`, `*exec*`). Claude Code matches a deny or ask
  rule's whole tool name as a glob, so such a rule can reach an OpenMausBot
  tool by pattern when it is called directly and miss the same call made as
  `use_tool`. Allow rules do not glob and are not given this test.
- The machine's managed policy, or a drop-in beside it, holds
  `allowManagedPermissionRulesOnly` (any case) with any value other than
  `false` or `null`: it may void the pre-approval of the whole agents server
  that the bridge on Claude Code rests on.
- One of those files is there and cannot be read as settings: it is not a
  regular file (a directory, a FIFO, a socket or a device there is refused
  without being opened), it is larger than 1 MB (refused without being read),
  it is not JSON, or its top level or its `hooks` is not an object.
- The Claude CLI is older than 1.0.122, the first with `--setting-sources`:
  it reads the person's own settings as well. The same goes while OpenMausBot
  has not yet read the CLI's version, which it does whenever it describes its
  engines (when the app loads, and on the Engines page).

Text **names the agents server** when, compared without regard to case, it
contains `mcp__agents` (so a server whose name merely starts that way counts
too), or contains `mcp__` directly followed by `*` or `?`: a wildcard in the
server position may reach the agents server. That is the whole test, for an
entry of a pattern list and for a settings file alike. A rule **has a
wildcard in a tool's name** when a `*` or `?` occurs outside parentheses,
where "outside" is a single flag set at `(` and cleared at `)`, exactly as the
CLI splits a tool list: `Bash(git *)` and `Read(./src/**)` have none,
`mcp__a*__vm_exec`, `*exec*` and `Bash(a),*` do. No pattern is ever built from
configuration text.

The files read are the ones the CLI reads. A bot's turn is launched with
`--setting-sources project` (`server/drivers/claude.ts:1620`), so that is
`.claude/settings.json` and `.claude/settings.local.json` in the folder the
turn runs in (the person's home folder when the turn has none of its own).
The machine's managed policy always applies:
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS,
`/etc/claude-code/managed-settings.json` on Linux, and on Windows
`C:\Program Files\ClaudeCode\managed-settings.json` and
`C:\ProgramData\ClaudeCode\managed-settings.json`, each with every `*.json`
file in a `managed-settings.d` folder beside it.

**Not read.** Claude Code can still take a rule about a tool by name from
places OpenMausBot does not read:

- policy an organisation delivers through the operating system: macOS managed
  preferences, the Windows registry;
- settings a Claude account's organisation sends from the server;
- a project subagent file under `.claude/agents/`, whose frontmatter takes
  `tools`, `disallowedTools` and `hooks` of its own;
- the frontmatter of a skill file (`disallowed-tools` or `disallowedTools`,
  and `hooks`), including the skills OpenMausBot itself links into a bot's
  workspace under `.claude/skills`, and of a slash-command file, which takes
  the same keys;
- hooks that come from a plugin a settings file enables, which live in the
  plugin, not in the file.

An organisation or a project that uses any of these to restrict OpenMausBot's
own tools should leave the bridge off: a rule there would see `use_tool`, not
the tool it ran.

## What changes for the person

Tool rows in a conversation, work summaries and the daily log name a bridged
call by the tool it ran (`mcp__agents__list_triggers`, not
`mcp__agents__use_tool`). A `use_tool` call that named no tool, or none that
exists, keeps its own name.

In a conversation this renaming happens only on a turn that was bridged. On
any other turn a tool called `use_tool` is left as it is: it belongs to some
other server. On a bridged turn the engines that are covered report a tool
with its server (`mcp__agents__use_tool` on Claude Code, `agents_use_tool` on
the chat runtime); were one to report a bare `use_tool`, another MCP server's
own tool of that name that happened to name one of OpenMausBot's tools would
be shown under the name it was given.

The bot's Activity log is read back from the event log, which knows only what
each call carried. It names a bridged call by its tool wherever the logged
name says the call was OpenMausBot's (`mcp__agents__use_tool`,
`agents_use_tool`); a bare `use_tool`, which could be any server's, is left
as "Use tool".

Two calls stay named `use_tool` everywhere: one whose record of its arguments
was cut short before the tool's name, which takes a very large call that put
its arguments first, and one on a thread whose mark was dropped because more
than 5,000 threads had bridged turns since.

The bot is told about the two tools in one sentence of its prompt, worded so
that it is true whether or not they are in its list.

`find_tool` matches on words, not meaning. A request that shares no word with
a tool's name, description or schema finds nothing and is given the list of
names instead.

## Checking a change

```sh
pnpm exec vitest run server/drivers/agents-bridge.test.ts server/drivers/agents-bridge-wire.test.ts server/drivers/agents-bridge-chat.test.ts server/drivers/agents-proxy.test.ts server/agents-bridge-switch.test.ts server/agents-bridge-names.test.ts server/agents-bridge-gates.test.ts server/agents-bridge.e2e.test.ts
```

The bridged list is pinned byte for byte, like the catalog itself. After any
change to a catalog tool, run `server/drivers/agents-catalog-wire.test.ts` and
`server/drivers/agents-bridge-wire.test.ts` once with
`UPDATE_AGENTS_CATALOG_GOLDENS=1`, review the golden diff, and move each file's
`BUDGET_BASELINE` by hand.
