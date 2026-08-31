# Chat turns

## Sub-features

- Create a bot through the normal profile boundary.
- Send to its active task.
- Distinguish settled, failed, stalled, timed-out, and needs-user outcomes.
- Read a bounded, redacted transcript.

## User path

Create or select a bot in the sidebar, type in the composer, and send.

## Driving it

```sh
pnpm control:omb new-bot --name Probe --url http://127.0.0.1:PORT
# Copy bot.id from the JSON above as BOT_ID.
pnpm control:omb send --bot BOT_ID --text "hello" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 10 --url http://127.0.0.1:PORT
```

The wait result must be `settled`, and the messages result must contain the
fake engine's bot response. Use `--dry-run` on `send` when checking a target or
command without starting a turn.

## Gotchas

- Sends are pinned to the active task; switch tasks before sending elsewhere.
- A bot working inside a channel must be awaited through that channel.
- `needs-user`, `failed`, and `stalled` are results, not successful settlement.
