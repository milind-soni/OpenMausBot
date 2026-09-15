# Work digests and context rebuilds

## Sub-features

- After every settled turn, on every engine, append one `digest` row: the
  tools the turn called (by name and count), the files it added or changed in
  a checkpointed project folder, memory it saved, and how good the evidence
  behind that is (`full`, `preview`, `none`).
- Replay the digests, not only the words, whenever the harness rebuilds a
  thread's context (rewind, engine switch, resume rejection, and every turn
  on the transcript-replay engines), selected by bytes newest-first.
- Record a compaction: `POST /api/bots/:id/tasks/:threadId/compact` appends a
  `compaction` row whose summary stands in for everything before it.
- Measure it: `GET /api/metrics?from&to` reports tokens per task, cache-hit
  share, replays, stable-prefix changes and evidence coverage per bot, per
  engine and per trigger.

## User path

The chat shows a small digest chip under each bot reply ("edited 2 files ·
Bash ×3 · memory ×1"). Switching a task to a different engine keeps working:
the new engine's first reply can name the files the old one changed.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/digest.e2e.test.ts
pnpm exec vitest run server/digest.test.ts server/context-rebuild.test.ts server/metrics.test.ts
```

The e2e boots the real server with one fake instance per engine family
(Claude, Codex, pi, ACP), runs a turn on each and asserts exactly one digest
naming that engine's tools; then a gated ACP turn edits two project files,
the digest names them, a switch to a second ACP instance replays that digest,
a compaction record is written, and the next replay leads with the summary
and no longer carries the first message. It ends by reading `/api/metrics`.

By hand, against a fixture:

```sh
node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb new-bot --name Probe --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "list the files here" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 5 --url http://127.0.0.1:PORT
curl -s "http://127.0.0.1:PORT/api/metrics?from=2026-09-01&to=2026-09-30" | head -c 600
```

The last message must be a `digest` row starting with `[digest]`.

## Gotchas

- The HTTP family and the box agent expose no tool calls, so their digests
  carry the reply and usage only and say `hookCoverage: "none"`. That is the
  documented degraded case, not a failure.
- File names appear only for a checkpointed project folder (the bot's own
  workspace is not snapshotted).
- `context.rebuildBytes` in config.json sets the replay budget (default
  24,000 bytes).
