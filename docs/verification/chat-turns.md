# Chat turns

## Sub-features

- Create a bot through the normal profile boundary.
- Send to its selected task or an explicitly pinned owned task.
- Run two bot tasks independently, with separate models and approval modes.
- Keep waits, approval responses, and Stop pinned while task selection changes.
- Distinguish settled, failed, stalled, timed-out, and needs-user outcomes.
- Read a bounded, redacted transcript.

## User path

Create or select a bot in the sidebar, type in the composer, and send.
Starting or selecting another bot task does not stop the previous one.

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

- Omitting `--task` snapshots the selected task before sending, waiting,
  reading, or stopping. Pass `--task THREAD_ID` to target another owned bot task
  without changing the selection. A channel send still requires its active task.
- `set-model --bot BOT_ID --task THREAD_ID --instance INSTANCE_ID --model MODEL_ID`
  changes only that idle task. Get exact available IDs from `control:omb models`.
  Without `--task`, the legacy model operation updates the bot default and its
  selected idle task, leaving other tasks unchanged.
- A bot working inside a channel must be awaited through that channel.
- `needs-user`, `failed`, and `stalled` are results, not successful settlement.

## Concurrent-task regression

```sh
pnpm exec vitest run server/independent-threads-api.test.ts
```

This test launches a fresh `control-omb` fixture for each case, wraps only its
fake engine with per-model completion gates, and uses the shared MCP/CLI surface
for pinned sends, waits, model changes, reads, and interrupts. It verifies two
tasks running under one bot, switching and creating while busy, separate model
and approval settings, stopping A without stopping B, transcript isolation, and
an unattended task remaining approval-blocked while its attended sibling runs.
It also exercises live provider capabilities against the memory-update route:
both sibling appends survive, stale replacements conflict, foreign ownership is
refused, and stopped-turn tokens expire without revoking the running sibling.
Provider working directories are checked against each task's private directory;
an explicitly shared project folder cannot launch a second engine until its
owner stops. On macOS, an inert computer descriptor inside the disposable home
checks lazy first-use ownership and exact-generation release through the real
control gate. It does not launch a desktop driver or prove actual UI actions.
The fixture prints its server log and a retained `.log.json` evidence path with
the exact control commands, wait results, and bounded transcripts. Its temporary
home is removed after the test.

See the [Threads renderer recipe](threads.md) for the real sidebar, composer,
optional folders, and group-history navigation checks.
