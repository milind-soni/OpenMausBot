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

## What this harness cannot prove

**Compaction does not fire here, and that is not a failure.** Two independent
reasons, both worth knowing before you spend an afternoon on it:

- `control-omb launch` builds its child env from scratch — an allowlist of
  platform keys plus fixed fixture values (see `childEnv` in
  `scripts/control-omb.ts`). Arbitrary parent env is dropped on purpose, so
  `OMB_CONTEXT_WINDOW=…` never reaches the server and every model keeps its
  real window.
- Compaction only runs on a turn that will REPLAY — a rewind, an engine
  switch, an external update, or an `omb-replay` engine. The fixture's fake
  engine resumes cleanly, so `willReplay` is false and no rebuild is
  attempted. A resumed turn paying nothing is the intended design, not a bug.

Driving 30 long turns against the fixture therefore produces zero compaction
records, correctly. The real coverage is `server/context/rebuild.test.ts`,
which exercises it against a live `Store`: the fold, the display path staying
whole, the summarizer prompt, previous-summary carry-forward, and the three
failure modes (no summarizer, a throwing one, a blank summary — all write
nothing and none fail the turn).

Closing this properly needs two changes to the control surface: forwarding
`OMB_CONTEXT_WINDOW` to the child, and a mapped command that can force a
replay path. Neither exists yet; do not add a map entry claiming otherwise.

## Gotchas

- Run on Node 24. On 22 the electron suite reports 10 cancelled subtests and
  `pnpm test` exits non-zero, which reads like a regression you just caused.
- Send a message containing a credential-shaped string and confirm it appears
  nowhere in the `context.prepared` lines. That log is what people paste into
  bug reports.
- Item counts are semantic units, not messages: one chat turn usually
  produces a user turn, an assistant turn, and a tool observation.
