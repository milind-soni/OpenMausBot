# Context runtime

## Sub-features

- Size a turn's history against the target model instead of a fixed count.
- Report who owns the context, and whether the model's limits were declared
  or guessed.
- Keep prompts, memory, tool output, paths, and credentials out of that report.

## User path

Invisible in normal use — it decides what the model remembers. The inspector
shows one `context` row per turn.

## Driving it

```sh
node --experimental-strip-types scripts/control-omb.ts launch
# second terminal, with the printed URL and dataDir
omb() { node --experimental-strip-types scripts/control-omb.ts "$@"; }
B=$(omb new-bot --name Ctx --url $URL | python3 -c "import sys,json;print(json.load(sys.stdin)['bot']['id'])")
for i in $(seq 1 50); do
  omb send --bot "$B" --text "turn $i: please remember the number $i" --url $URL
  omb wait --bot "$B" --timeout 30 --url $URL
done
grep context.prepared "$DATA_DIR"/events/*.ndjson | tail -1 | python3 -m json.tool
```

`control-omb` has no mapped command for context metadata, so the evidence is
the canonical event log the server writes for itself. Reading a file the
fixture already produced is not the same as improvising API calls against a
live instance; do not reach past the control tool for anything that mutates.

## Expected

`sentItems` climbs past 40 as the thread grows — the old `.slice(-40)` made
that impossible. On a 200k window nothing clips:

```json
{"type":"context.prepared","ownership":"vendor-session","mode":"resume-preferred",
 "sourceItems":151,"sentItems":151,"estimatedInputTokens":2314,
 "historyTokens":177189,"contextWindow":200000,"limitsSource":"pattern",
 "compacted":false,"clipped":false}
```

`limitsSource: "pattern"` is honest and expected here: 200k is this repo's
family floor for `claude-*`, not a figure the driver declared. Only
`"catalog"` means the engine actually said so.

## Driving compaction

Compaction needs two things the default fixture does not give you: a window
small enough to overflow on a short thread, and a turn that REBUILDS rather
than resumes. A cleanly resumed turn never compacts — the vendor CLI owns its
own context, and that is by design.

```sh
OMB_CONTEXT_WINDOW=12000 node --experimental-strip-types scripts/control-omb.ts launch
```

`launch` builds its child env from scratch so the fixture cannot inherit your
shell; `OMB_CONTEXT_WINDOW` and `FAKE_CLAUDE_MODE` are the two overrides it
forwards when explicitly set, because without them whole features cannot be
exercised here.

Then fill the thread past the budget and rewind:

```sh
omb() { node --experimental-strip-types scripts/control-omb.ts "$@"; }
LONG=$(python3 -c "print('please remember this carefully: ' + 'context ' * 150)")
for i in $(seq 1 30); do
  omb send --bot "$BOT" --text "turn $i: $LONG" --url $URL
  omb wait --bot "$BOT" --timeout 30 --url $URL
done
# edit the LATEST user turn — editing an early one forks away the history you
# just built, and the shorter branch fits again
omb edit --bot "$BOT" --message "$LAST_USER_MESSAGE_ID" --text "summarise everything" --url $URL
omb wait --bot "$BOT" --timeout 30 --url $URL
```

`edit` is the rewind a person performs in the composer, and the only mapped
way to make the harness rebuild instead of resume.

Expected — the last `context.prepared` reports `"mode":"replay-required"` and
`"compacted":true`, and one record lands in the database:

```sh
sqlite3 "$DATA_DIR/messages.db" "SELECT json FROM messages WHERE kind='compaction'"
```

Observed on 2026-09-04: `tokensBefore 5358` against a 4,800-token budget on a
12k window, one record, the display path still holding every message.

## Gotchas

- Run on Node 24. On 22 the electron suite reports 10 cancelled subtests and
  `pnpm test` exits non-zero, which reads like a regression you just caused.
- Send a message containing a credential-shaped string and confirm it appears
  nowhere in the `context.prepared` lines. That log is what people paste into
  bug reports.
- Item counts are semantic units, not messages: one chat turn usually
  produces a user turn, an assistant turn, and a tool observation.
- A resumed turn never compacts. If `mode` says `resume-preferred`, no rebuild
  was attempted and `compacted:false` proves nothing about compaction.
- Rewind at the newest user turn. An edit forks the branch at that message, so
  editing an early one discards the history you were trying to overflow.
