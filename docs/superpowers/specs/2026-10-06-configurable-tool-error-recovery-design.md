# Configurable Tool-Error Recovery (Corrective Rounds)

## Summary

A bot's turn currently ends with `tool_error` whenever it produces a final
answer while a tool op in that turn failed or was denied (#2378). Routine
failures — a non-zero `host_shell_exec` exit, a zsh glob error, a bad
argument — therefore kill the whole turn, and `tool_error` is not
auto-continued, so the work halts until a person re-dispatches it.

Add one global, persisted setting: how many corrective rounds a turn may feed
back to the model after a failed tool op (its result marked `ok:false`) before
the turn ends. Keep zero as the default so upstream behavior is unchanged.

## Goals

- Let users let a bot self-recover from routine tool failures in the same turn.
- Preserve the current behavior (end the turn on a done-after-failure) for
  existing installations (default 0).
- Never retry a person's denial: the corrective round is gated on the turn
  having recorded **no** `denials` (an approval "no" or an unanswered ask).
- Bound the recovery: a hard cap on corrective rounds per turn, so a genuinely
  stuck bot still ends with `tool_error` (and can be auto-continued via the
  cap path).
- Apply without restarting the server or reloading providers.

## Non-goals

- Per-bot or per-tool overrides.
- Changing what counts as a tool failure or denial.
- Removing the `tool_error` terminal class.
- Re-asking a person, or continuing a denied action in an unattended thread.

## Configuration Model

Add a `toolErrors` section to the persisted application configuration:

```json
{
  "toolErrors": {
    "correctiveRounds": 2
  }
}
```

`correctiveRounds` is a whole number from 0 through 5. Missing values resolve
to 0, preserving the historic behavior. Stored configuration and API patches
reject negative, fractional, non-numeric, out-of-range, and structurally
invalid values (the section is `.strict()`, so unknown keys are rejected too).

The public config status includes the effective value because it is non-secret:

```json
{
  "toolErrors": {
    "correctiveRounds": 2
  }
}
```

Saving only this section must not reload providers or interrupt active turns.

## Server Behavior

The value is read once per turn dispatch in `server/index.ts`
(`toolErrorCorrectiveRounds(cfg)`) and carried on `SendTurnInput` as
`toolErrorCorrectiveRounds` — the same per-turn channel as
`mcpCallTimeoutMs`. The openai-compat chat runtime consults it at the
done-after-failure check:

- `correctiveRounds === 0` (default): unchanged — throw `tool_error`.
- `correctiveRounds > 0`, rounds remain, **and `denials.length === 0`**: reset
  the `toolFailed` latch, push one corrective user round ("Re-run the failed
  operations with corrected inputs where possible, verify their state, and
  then give your final answer. Do not fabricate results."), and `continue`
  the round loop.
- Rounds exhausted or a denial recorded: fall through to the normal
  `tool_error` throw.

Because `denials` records every approval "no" (and unanswered or malformed
`ask_user`), a corrective round is never issued after a person refused — the
corrective text only repeats what the tool results already marked `ok:false`.

The value is captured at dispatch and used per turn, so changing the setting
affects the next dispatched turn and never retroactively rewrites an in-flight
turn's behavior.

## User Interface

Add a "Tool errors" card to `Settings > General`, alongside the "MCP calls"
card. The card follows the current `Card` and input styles.

The card contains:

- A `Corrective rounds` label.
- A numeric input showing the current value.
- A `rounds` suffix.
- Supporting text explaining the setting: how many times a turn may ask the
  model to re-run failed tool operations before it ends; 0 keeps the default;
  a person's denial is never retried.

The field accepts whole numbers from 0 through 5. It saves on blur, matching
the other timeout fields. Pressing Enter blurs and saves. Invalid input stays
visible with the existing danger treatment and is not sent to the server.

## Data Flow

1. `GET /api/config` returns `toolErrors.correctiveRounds` with a default of 0.
2. The General settings card renders it; blur/Enter issues
   `PUT /api/config` with `{ "toolErrors": { "correctiveRounds": N } }`.
3. `server/index.ts` re-reads `cfg`, broadcasts the new config status, and the
   next turn dispatch carries `toolErrorCorrectiveRounds` on `SendTurnInput`.
4. The openai-compat runtime feeds the corrective round at the
   done-after-failure check, bounded by the configured cap.

## Tests

- `server/config.test.ts`: accepted persisted value; default 0; invalid values
  rejected (negative, fractional, >5, non-numeric, null); unknown `toolErrors`
  keys rejected.
- `src/lib/tool-error-recovery.test.ts`: parser bounds and formatting.
- `server/drivers/openai-chat.test.ts`: a new test verifies that with
  `toolErrorCorrectiveRounds: 1`, a done-after-failure feeds exactly one
  corrective round (absent from the first request, present in the last), the
  retry tool call runs, and the second done still ends with `tool_error` once
  the cap is exhausted. The existing default-path test still asserts no
  corrective round when the field is absent.
- `src/state/store.test.ts` / `SettingsModal.connections.test.ts`:
  `toolErrors` is part of the config status frame.
- `scripts/generate-locale.mjs --check`: locale catalogs stay valid.
