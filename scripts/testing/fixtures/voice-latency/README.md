# Voice latency corpus and measurement

A committed corpus fixture and a measurement harness for the voice-reply
pipeline: the harness drives the real app pipeline against the corpus and
writes a run log, so a speak-pipeline change can be judged on identical
replays before and after it.

## Files

- `corpus.json` — the adversarial corpus (canonical form, trailing newline).
  `corpusFixtureId` = sha256 of this exact file.
- `manifest.json` — fixture ID, per-reply char/block counts from the real
  `toUtterances` splitter (`server/tts/speech-text.ts`), shape pins, totals,
  and the protocol pins both sides share (replay cadence, gap threshold,
  modeled synthesis timing).
- `logs/before-<sha12>.json` — the baseline run, recorded before any of the
  speak-pipeline changes. A later after-run lands beside it as
  `logs/after-<sha12>.json` with the same corpus sha in the name.
- `logs/firstbyte-<sha12>.json` — the synthesis-leg row for the
  319-char reply (see Streamed delivery below).
- `logs/firstblock-<sha12>.json` — the first-block listing: every
  corpus reply's first-block char count from the capped splitter
  (`node --experimental-strip-types scripts/testing/voice-latency-firstblock.ts`),
  offline and deterministic (no engine, no key, no audio).

Regenerate (must reproduce the committed bytes exactly):

```
node --experimental-strip-types scripts/testing/voice-latency-corpus.ts
```

## Shapes

Pinned first blocks (verified by `voice-latency-corpus.test.ts` against the
real splitter): unpunctuated run 319, code list 211, em-dash list 153, typical
medium 26, staccato one 92-char block, mixed reply whose last block is 319.
Totals: 116 blocks, mean ~66 chars.

## Protocol

Synthesis comes from the record stub, not the live engine:
`voice-latency-stub.ts` serves the ElevenLabs wire shape
(`server/tts/elevenlabs.ts`) on loopback, and the harness points the fixture
server at it through `OMB_ELEVENLABS_API`. No live engine call, no engine key:
record runs need no `OMB_TTS_KEY` and never reach api.elevenlabs.io; the stub
key in the fixture config is a literal that only ever reaches loopback.

Modeled timing, identical on both sides and pinned in `manifest.json`
(`synthesis`): clip duration 70 ms per text char, synthesis latency RTF 0.5 ×
that (35 ms/char). This reproduces the pinned worst case: a 319-char block
models 11.2 s of synthesis. The stub returns silent MPEG-1 Layer III frames
(26.12 ms each) whose count carries the modeled clip duration, so the
browser's real playback time is the model. Every synthesis-derived number in a
run log is labeled `"modeled": true` (log `synthesis` block, `totals`, each
reply row).

Streamed delivery: `synthesize()` posts to the
`/text-to-speech/{voice}/stream` route, and the stub always answers
streamed — first chunk at the pinned modeled first-byte latency
(`synthesis.firstByteMs`), remaining chunks spread so the last byte still
lands at the whole-clip synthesis time. Generation is unchanged; only
delivery streams. The synthesis-leg proof row for the 319-char reply is
`logs/firstbyte-<sha12>.json`, produced by
node --experimental-strip-types scripts/testing/voice-latency-firstbyte.ts;
every timing in it is modeled.

Delta replay cadence, identical on both sides: `FAKE_CLAUDE_STREAM_CADENCE`
(server/testing/fake-claude-cli.ts) streams each scripted reply as 24-char
`text_delta` chunks every 150 ms (160 chars/s) before the assistant message.
Injection point: the fake claude CLI's turn output — the real driver
(server/drivers/claude.ts stream_event → content.delta) forwards it, the
server broadcasts {kind:"runtime"} frames, and the renderer store records
arrival (src/lib/voice-latency-probe.ts, enabled only by `?ombVoiceProbe=1`
on the preview page).

Reply routing is by prompt marker, not ordered slots: the harness POSTs
`omb voice probe <id>` as the user text and the fake CLI answers with that
marker's corpus reply (`FAKE_CLAUDE_MARKER_REPLIES`). The driver legitimately
replays a user message over several CLI launches; marker routing makes every
replay answer the same reply, so rows align regardless of replay count. A
turn settles only after its own reply's full-length complete frame plus 4
quiet 500 ms polls; the audio frame is the fresh frame whose `textChars`
equals the corpus reply's length.

t0 = arrival of the first `content.delta` runtime frame for the turn. First
audio = `play()` resolving on block 0. A gap is a silence between the end of
block j and the start of block j+1 longer than 200 ms, counted after first
audio, within one reply.

Instrumentation is inert without the probe sink: with the harness disabled, the
speak path and the discard-delta behavior (src/state/store.tsx
runtimeFrameAction / case "runtime") are byte-for-byte the shipped path.
src/state/store.test.ts and src/lib/tts/index.test.ts pin that.

## Run

```
node --experimental-strip-types scripts/testing/voice-latency-harness.ts --label before
```

No environment setup: the run is keyless and self-contained (it launches the
stub, the disposable fixture server and the browser itself, and never reads
the live `~/.openmausbot/config.json`). One warmup reply is spoken and
discarded, then every corpus reply in order. Each log row: reply id, shape,
t0-to-first-audio ms, gap count, total gap ms, longest gap ms (plus
t0→message-frame and message-frame→first-audio splits). The summary carries
worst-case first audio, total gaps, single longest gap, corpus fixture ID,
base commit, measured-build commit, date, machine, the config labels
(provider/model/voice name only) and the synthesis model (protocol, RTF,
ms-per-char). Deterministic pieces (corpus regeneration, manifest consistency,
stub timing math, gap accounting) are unit-tested; the live measurement itself
is a run, not a test.
