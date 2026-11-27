# Configurable MCP Call Timeout

## Summary

Every bot MCP tool call on the chat-MCP transport is cut at a fixed 10-minute
ceiling (`CALL_MS` in `server/drivers/chat-mcp-tools.ts`). Long-running tool
calls — a full `xcodebuild test` or gradle run through a host-shell MCP tool —
routinely trip that ceiling: "MCP request timed out; execution outcome may be
uncertain". The ceiling is not configurable and no environment override exists.

Add one global, persisted MCP call timeout setting. Keep ten minutes as the
default, expose the setting in the existing General settings UI, and use the
configured value for tool calls on turns started after the setting is saved.

## Goals

- Let users configure the maximum duration of a single MCP tool call.
- Preserve the current ten-minute behavior for existing installations.
- Make the setting discoverable and editable in the existing app settings UI.
- Apply updates without restarting the server or reloading providers.
- Keep the MCP call ceiling distinct from the room turn ceiling
  (`rooms.turnTimeoutMinutes`) and the inactivity stall watchdog.

## Non-goals

- Per-bot or per-tool timeout overrides.
- Changing `rooms.turnTimeoutMinutes` or the stall watchdog.
- Changing the MCP `STARTUP_MS` (8 s) startup budget or any other MCP constant.
- Retiming MCP calls already in flight when the setting changes (each call
  captures its value at mount time, per turn).
- An environment-variable override (the persisted setting is the knob).

## Configuration Model

Add an `mcp` section to the persisted application configuration:

```json
{
  "mcp": {
    "callTimeoutMinutes": 10
  }
}
```

`callTimeoutMinutes` is a whole number from 1 through 60. Missing values
resolve to 10, so existing configuration files retain the current behavior.
Stored configuration and API patches reject non-numeric, fractional,
out-of-range, and structurally invalid values (the section is `.strict()`, so
unknown keys are rejected too).

The public config status includes the effective value because it is non-secret:

```json
{
  "mcp": {
    "callTimeoutMinutes": 10
  }
}
```

Saving only this section must not reload providers or interrupt active turns.
The server updates its in-memory application config and broadcasts the new
config status through the existing config event.

## Server Behavior

The value is read once per turn dispatch in `server/index.ts`
(`mcpCallTimeoutMinutes(cfg) * 60_000`) and carried on `SendTurnInput` as
`mcpCallTimeoutMs` — the same per-turn channel `mcpFromUserConfig` uses. The
openai-compat chat runtime passes it into `mountChatTools(...)`, which
defaults to the historic 10-minute constant when the field is absent (direct
driver, older paired clients, other callers).

Because the value is captured at dispatch time and threaded per turn, changing
the setting affects the next dispatched turn and never silently moves the
deadline of a call already in flight.

On timeout, the existing behavior is unchanged: the tool call fails with the
"MCP request timed out; execution outcome may be uncertain" message and the
call's `ChatToolSessionError` propagates to the turn.

## User Interface

Add an "MCP calls" card to `Settings > General`, alongside the existing
`Room turns` card. The card follows the current `Card` and input styles.

The card contains:

- A `Maximum call length` label.
- A numeric input showing the current value.
- A `minutes` suffix.
- Supporting text explaining that the limit applies to every MCP tool call a
  bot makes, and that a call past the ceiling stops with an
  uncertain-outcome warning.

The field accepts whole minutes from 1 through 60. It saves on blur, matching
the Room turns field. Pressing Enter blurs the field and saves. Invalid input
remains visible with the existing danger color treatment and is not sent to
the server. When a config status update arrives, the field synchronizes to the
server value unless the user is actively editing it.

## Data Flow

1. `GET /api/config` returns `mcp.callTimeoutMinutes` with an effective
   default of 10.
2. The General settings card renders it; blur/Enter issues
   `PUT /api/config` with `{ "mcp": { "callTimeoutMinutes": N } }`.
3. `server/index.ts` re-reads `cfg`, broadcasts the new config status, and
   the next turn dispatch carries `mcpCallTimeoutMs` on `SendTurnInput`.
4. `mountChatTools` uses that value for every `tools/call` on the turn.

## Tests

- `server/config.test.ts`: accepted persisted value; invalid values rejected
  (0, fractional, >60, non-numeric, null); unknown `mcp` keys rejected.
- `src/lib/mcp-call-timeout.test.ts`: parser bounds and formatting.
- `server/drivers/chat-mcp-tools.test.ts`: a short configured timeout trips
  the timeout on a slow server; a generous one lets the same call complete.
- `src/state/store.test.ts` / `SettingsModal.connections.test.ts`:
  `mcp` is part of the config status frame.
- `scripts/generate-locale.mjs --check`: locale catalogs stay valid.
