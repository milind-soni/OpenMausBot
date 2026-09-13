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

## Surface gating: Works on = Off

Off withholds both surfaces. No other path may hand that bot the built-in
browser, and the turn must tell the model it has no screen rather than leave
it to narrate a browser it cannot call.

```sh
node --experimental-strip-types scripts/control-omb.ts launch
# second terminal, using the printed URL
pnpm control:omb new-bot --name Orbit --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "list my calendar events" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 40 --url http://127.0.0.1:PORT
# the fixture's own API sets the destination the Works on picker sets
curl -s -X PATCH "http://127.0.0.1:PORT/api/bots/BOT_ID" \
  -H 'content-type: application/json' -d '{"computer":"off"}'
pnpm control:omb send --bot BOT_ID --text "open a browser and check my calendar" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 40 --url http://127.0.0.1:PORT
```

After each settled turn read `fake-claude-dump.json` in the fixture's printed
`dataDir`: it holds the exact `systemPrompt` and `mcpConfig` that engine run
received. The Auto turn must carry no Works-on sentence. The Off turn's prompt
must say the setting is Off and that no computer and no built-in browser are
mounted. Repeat through a channel — the room path resolves its surface
separately — and mention a second Auto bot in the same room as the control.

Proving the browser server's own absence from `mcpConfig` needs a fixture with
a real browser engine; see [Live browser and profiles](browser-live.md). The
dump above proves what the model was told, not what a native browser would do.

### Last exercised

2026-09-12, isolated macOS fixture on port 21008. A bot on Auto settled with
`mcpConfig` servers `agents` and `ogb` and no Works-on sentence. The same bot
patched to `computer: "off"` settled with the Works-on-Off sentence in its
system prompt. A channel send to that bot carried the same sentence in the room
prompt; an Auto bot mentioned in the same room did not. The fixture and its
temporary data directory were removed with Ctrl-C afterwards.

Maintainer review, 2026-09-12: repeated against an isolated fixture with the
native agent-browser 0.37.0 and Chrome for Testing explicitly installed. The
fake model's captured MCP configuration included `browser` for Auto and
Browser-only direct turns, and omitted it for Off direct and Off room turns.
All four turns settled and the fixture was closed. This proves tool mounting
with an available engine; it does not claim a browser navigation or a real
provider response. Only server names and bounded fixture messages were retained,
not the capability tokens in the raw MCP configuration.

## Queued follow-up recovery

Accepted bot and channel follow-ups are committed to the transcript database
before acknowledgement. A normal restart restores only work whose dispatch has
not begun. A claimed dispatch has an uncertain outcome: retain the user's words
and a visible review notice instead of automatically repeating the action.
Cancellation receipts survive restart. Importing a workspace backup pauses all
of its queued work for review, even when restoring to the original directory.

```sh
pnpm exec vitest run server/chat-followups.test.ts server/chat-followups-restart.test.ts server/workspace-backup.test.ts
```

The restart test launches an isolated real server with the fake engine, accepts
queued bot/channel sends, kills only that fixture server, and starts a replacement
against the same disposable home. It checks original receipts, native image
content, reply targets, cancellation conflicts, one uncertain-dispatch notice,
and a second restart without replay. It records the fixture log and a retained
`.log.chat-followups-restart.json` receipt before removing the temporary home.
This does not prove resumption or cleanup of real provider sessions after a crash.

## Concurrent-task regression

### Delegation mailbox

Queued handoffs now wait through repeated busy turns rather than giving up
after three. The delivery window is 24 hours; an hourly sweep expires a
handoff that is still unable to run, reports the failure, and wakes its sender.
A free target can accept an overdue handoff. At restart, already elapsed
windows receive a fresh 24 hours **before** dispatching any recovered jobs;
otherwise the first job can occupy the target and expire the rest of its
backlog. Valid, unexpired windows retain their saved deadlines. This is a
wall-clock window, not precise uptime accounting: sleep within a running
process counts. A routine waiting on a peer skips overlapping interval fires
until the handoff settles (potentially about 25 hours); it never duplicates
the pending job to catch up.

```sh
pnpm exec vitest run server/delegations.test.ts server/peer-roster.test.ts server/drivers/agents-proxy.test.ts
pnpm exec vitest run server/independent-threads-api.test.ts -t 'holds a delegation behind an approval'
pnpm exec vitest run server/comms.test.ts
```

The mailbox API fixture uses the isolated launcher and per-model fake-engine
gates. A peer waits on a real approval-broker card; a Chief delegates through
its captured turn capability and finishes. The roster reports waiting on the
user, exactly one waiting chip appears, approving releases the peer, and one
attributed result returns to the Chief without another user prompt. Exact
control commands, waits, transcripts and the server log path are retained in
the fixture's `.log.json` evidence, without capability tokens. Queue-unit
tests cover expiry, multi-job restart recovery, repeated busy periods and
persisted deadlines. These tests do not claim real-provider performance.

### Independent tasks

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

## CLI Stop regression

```sh
pnpm exec vitest run server/kill-tree.test.ts server/engine-install.test.ts server/cli-stop.e2e.test.ts
```

The Stop fixture wraps only the isolated launcher's fake Claude CLI with an
owned helper that ignores TERM. It covers both a root that exits first and a
root that also ignores TERM: the task stays busy during the grace period,
settles only after both PIDs are gone, and accepts a subsequent message.
The printed `.log.json` retains exact control commands, waits, transcripts,
and PID checks. No real engine, account, or user's app data is used.

Focused process checks also cover concurrent stops, denied signals, unrelated
process safety, and bounded npm timeout errors. Codex's driver tests retain
task ownership after an uncertain stop until a verified retry; Antigravity's
lifecycle tests retain the verification profile on the same failure.
POSIX group escalation and the
new server cases are skipped on Windows; its existing `taskkill /T /F` path
remains covered by the cross-platform child-tree test when run on Windows.
Windows event-order regressions also run on every host in
`server/kill-tree-windows.test.ts`: successful `taskkill` alone is not proof
that Node observed the child's exit. Both orders (exit before or after the
command callback) must settle without waiting for inherited pipes to close;
an unobserved exit still times out as uncertain. The native Antigravity
`closeAndWait` test in Windows CI verifies that callers cannot rename an
executable while its process is still running. Local mocked Windows tests
do not substitute for that native check.
Processes that intentionally detach into a different group are not owned by
this POSIX group-based cancellation.
