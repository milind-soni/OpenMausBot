# Tool selection

Open a bot's **Access → Tool selection** settings to reduce the tools sent to
its model. This is useful for local models with a small context window.

- **All current tools** keeps the existing engine and integration defaults.
- **Custom selection**, with **Only allow listed tools** checked, offers only
  the tools in Allow. An empty Allow list selects **no tools**.
- Uncheck **Only allow listed tools** to keep the current catalog except for
  tools in Exclude. Exclude always wins.

Enter one selector per line, then choose **Save tool selection**. Changes take
effect on the next turn. Finish the bot's active tasks before saving. A failed
save never grants newly enabled tools. Changes that remove tool access can
remain active in the running app even if saving fails; retry the save to keep
them after a restart. Duplicating a bot preserves its selection from the moment
the copy is created.

## Names and examples

Use the tool's original, case-sensitive name, before any model-specific alias:

```text
native:read
mcp:mail:read_notes
```

`native:*` includes the engine's native tools. `mcp:mail:*` includes all tools
on the configured server named `mail`. Partial wildcards, such as
`native:read*`, are invalid. A valid name that is not available selects
nothing; it does not fall back to all tools. The Allow and Exclude lists each
accept up to 256 selectors, with at most 1024 characters per selector.

**Pi drafting**, with Only allow listed tools checked:

```text
native:read
native:edit
native:write
```

**Grok CLI drafting**:

```text
native:read_file
native:search_replace
native:write
```

**Pi with one custom MCP tool**:

```text
mcp:mail:read_notes
```

Select the `mail` server in the existing MCP servers card too. A selector
does not enable a disabled server, connect an account, or grant integration
access.

**Grok CLI with one custom MCP tool** needs its native lookup and call tools
explicitly selected:

```text
native:search_tool
native:use_tool
mcp:mail:read_notes
```

Grok uses those two helpers to discover and call the selected MCP tools.
Their results and calls are checked against the same original selectors.
Pi sends the selected MCP schemas directly to the model.

## Engine support

| Engines | Available selection |
| --- | --- |
| Pi, Grok CLI, Grok API, OpenAI compatible, Mistral, MiniMax | Native and app-supplied MCP tools |
| Claude, Codex, Gemini, Kimi, Droid, Cursor, OpenCode Go, Qwen, Hermes, Custom ACP, Antigravity | App-supplied MCP tools; keep `native:*` in Allow and do not exclude native tools |
| Boat native | Meaningful tool restrictions are unsupported |

Grok CLI's native contract is verified on version **1.0.41**. Other versions
refuse native restrictions until their contract is verified. Inherited Grok
profile restrictions still apply. Grok accepts simple `[agent]` name/definition
entries, including trailing comments, and an explicit `--agent-profile` file.
Quoted or dotted keys, inline agent tables, multiline TOML, conflicting
profile sources and CLI tool overrides refuse scoped turns when their existing
restrictions cannot be safely resolved. Scoped Grok disables its managed MCP gateway;
unexpected native MCP servers prevent the prompt from starting. Scoped Claude
requires a modern CLI with strict MCP isolation and cannot inherit its native
MCP configuration. Scoped Codex checks its effective MCP configuration before
starting the prompt. Each Codex MCP mount keeps independent private gate
settings on new and resumed threads; custom servers retain approval prompts.

Unsupported restrictions and malformed saved selections stop the turn with a
setup error. The settings warning is deliberate: it does not claim an engine
can enforce a restriction that its contract does not support. Native selection
for the other CLI engines remains a later contribution requiring verified
provider contracts.

## Approvals and access

Selection narrows available tools. Existing approval modes, guest restrictions,
integration permissions and host-control confirmation still apply. Auto or
Full approval does not re-enable an excluded tool. MCP discovery and calls are
both filtered, including URL-backed servers and zero result budgets.

This is tool availability, not a sandbox for commands, file access or
credentials. Allowing a shell tool still allows that tool's existing authority.
Bot-proposed profile changes cannot edit this owner setting.
