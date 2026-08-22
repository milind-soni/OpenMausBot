# Configurable Room Turn Timeout

## Summary

OpenMausBot currently stops every room member turn after five minutes, even when the engine is still producing output. The duration and the error message are hard-coded in `server/index.ts`. This behavior is separate from the activity-based turn stall watchdog controlled by `OMB_TURN_STALL_MS`.

Add one global, persisted room turn timeout setting. Keep five minutes as the default, expose the setting in the existing General settings UI, and use the configured value for room turns started after the setting is saved.

## Goals

- Let users configure the maximum duration of a room member turn.
- Preserve the current five-minute behavior for existing installations.
- Make the setting discoverable and editable in the existing app settings UI.
- Apply updates without restarting the server or reloading providers.
- Report the configured duration in timeout activity messages.
- Keep the room turn ceiling distinct from the inactivity-based turn stall watchdog.

## Non-goals

- Per-room or per-bot timeout overrides.
- Changing `OMB_TURN_STALL_MS` or the semantics of the stall watchdog.
- Changing provider-specific approval or RPC timeouts.
- Retiming room turns that are already running when the setting changes.
- Adding an environment-variable override for the room turn ceiling.

## Configuration Model

Add a `rooms` section to the persisted application configuration:

```json
{
  "rooms": {
    "turnTimeoutMinutes": 5
  }
}
```

`turnTimeoutMinutes` is a whole number from 1 through 1,440. Missing values resolve to 5, so existing configuration files retain the current behavior. Stored configuration and API patches reject non-numeric, fractional, out-of-range, and structurally invalid values.

The public config status includes the effective value because it is non-secret:

```json
{
  "rooms": {
    "turnTimeoutMinutes": 5
  }
}
```

Saving only this section must not reload providers or interrupt active turns. The server updates its in-memory application config and broadcasts the new config status through the existing config event.

## Server Behavior

When a room member turn is dispatched, the server reads the effective global timeout and captures it for that turn. The timer uses that captured value, so changing the setting affects the next room turn and does not silently move the deadline of a turn already in progress.

On timeout, the server keeps the existing interruption and room ownership behavior. Only the timer duration and activity text become dynamic. The message uses readable singular and plural forms, for example:

- `Atlas's room turn exceeded 1 minute and was stopped`
- `Atlas's room turn exceeded 20 minutes and was stopped`

The turn stall watchdog remains activity-based and independent. A room turn can therefore stop because it reaches the configured absolute ceiling or because it becomes inactive long enough for the existing watchdog to fire.

## User Interface

Add a `Room turns` card to `Settings > General`, alongside the existing global settings cards. The card follows the current `Card` and input styles instead of introducing a new settings pattern.

The card contains:

- A `Maximum turn length` label.
- A numeric input showing the current value.
- A `minutes` suffix.
- Supporting text explaining that the limit applies to every bot turn in rooms and that direct chats use the inactivity watchdog instead.

The field accepts whole minutes from 1 through 1,440. It saves on blur, matching the Profile fields. Pressing Enter blurs the field and saves. Invalid input remains visible with the existing danger color treatment, shows a concise inline validation message, and is not sent to the server. A failed save also keeps the entered value visible and reports the server error inline.

When a config status update arrives, the field synchronizes to the server value unless the user is actively editing it. This prevents a stale config event from replacing in-progress input.

## Data Flow

1. `GET /api/config` returns `rooms.turnTimeoutMinutes` with an effective default of 5.
2. The app store hydrates and folds config events with the `rooms` status included.
3. The General settings card edits the value and sends `PUT /api/config` with only the `rooms` patch.
4. The server validates and persists the patch, updates the live config object, and broadcasts the resulting config status.
5. Each new room member turn captures the effective duration and starts its absolute timeout timer.
6. If the timer fires first, the server interrupts the provider and records the dynamic timeout activity message.

## Error Handling

- Client-side validation prevents empty, fractional, non-numeric, and out-of-range values from being submitted.
- Server-side schema validation remains authoritative and returns HTTP 400 for invalid patches.
- Save failures appear next to the field without changing the last confirmed setting in application state.
- Existing room timeout cleanup and ownership safeguards remain unchanged.

## Testing

Add focused coverage for:

- Stored configuration parsing with a valid room timeout.
- Defaulting missing room settings to five minutes in config status.
- Rejecting malformed and out-of-range room timeout patches.
- Persisting and returning an updated room timeout through `/api/config`.
- Folding the `rooms` section from config events into client state.
- Client validation and save behavior for the General settings field.
- The room turn timer using a configurable duration and formatting singular and plural timeout messages.
- Existing behavior remaining at five minutes when no setting is present.

Run the focused tests first, followed by the repository typecheck, lint, and relevant full test suite before publishing the pull request.

## Pull Request Scope

The pull request will contain only the configuration contract, room timeout behavior, General settings UI, focused tests, and supporting documentation needed for this change. The pull request title, body, commits, code comments, UI copy, and tests will be written in English.
