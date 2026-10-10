# Calls on Windows and Linux: universal speech recognition

Decision doc. Supersedes the "Calls are macOS-only, because dictation is" line
in [voice-mode.md](voice-mode.md).

## Shape

```
Renderer (src/)                                  Harness (server/)
├── lib/stt/bridge.ts        one bridge          ├── routes/stt.ts   POST /api/stt/transcribe
│     darwin  → window.ogb.speech* (Swift)       │     strict WAV gate · 30 s cap · 409/413/415
│     win/linux → UniversalSpeechEngine          └── stt/
├── lib/stt/engine.ts        capture + turns           ├── index.ts              provider choice, describe
│     getUserMedia (AEC/NS/AGC) → 16 kHz               ├── openai-compatible.ts  OpenAI · Groq · local
│     AudioContext → worklet → 20 ms Int16             ├── xai.ts                Grok STT (reuses xai.key)
├── lib/stt/endpointer.ts    energy VAD                └── wav.ts                16 kHz mono s16 only
└── components/CallView.tsx  unchanged state machine
```

## The seam

CallView, GroupCallView, Composer and push-to-talk already depended on exactly
five calls: `speechStart({ endpointMs })`, `speechStop`, `speechFinish`,
`onSpeechTranscript`, `onSpeechEnd`. `UniversalSpeechEngine` implements the same
contract, including the two subtle parts the call loop relies on:

- `stop()` emits nothing. An intentional mute before the bot speaks must never
  look like the natural end of a turn.
- A final transcript is emitted before `end`, and a `start()` issued from inside
  the final-transcript callback suppresses the old session's `end`.

On macOS `speechBridge()` is a pass-through to the Swift helper; Mac behavior is
unchanged (`src/lib/stt/bridge.test.ts` pins that).

## Why capture in the renderer

- Chromium's WebRTC echo cancellation, noise suppression and gain control come
  for free. The Swift helper has none.
- No native addon to rebuild per Electron ABI, no `sox` binary to ship.
- `electron/app-permissions.mjs` already allows local-page audio capture.
- The Web Speech API is not an option: Chromium's recognizer depends on
  Google's service key, which Electron builds do not carry.

## Turn-taking

Half-duplex, as before. The mic is gated whenever no session is live: the track
is disabled and frames are dropped. In call mode the device stays open
between turns, so re-listening after the bot speaks costs nothing. `endCall()`
releases it, and it auto-releases after 30 s idle. Composer dictation releases
it immediately.

The endpointer is energy-based with an adaptive noise floor, entry/stay
hysteresis, 300 ms pre-roll, and a 240 ms calibration window that absorbs the
tail of the bot's playback. It is a small pure class, so a Silero VAD (ONNX)
can replace it without touching the engine.

## Providers

| Provider | Credential | Notes |
|---|---|---|
| Local server | none (address + model) | Any `/v1/audio/transcriptions` server: speaches (faster-whisper), whisper.cpp `--inference-path`, LocalAI. Offline. Live captions on. |
| Groq | `stt.groqKey` | `whisper-large-v3-turbo` by default. Fastest cloud option. |
| OpenAI | `stt.openaiKey` | `gpt-4o-mini-transcribe` by default. |
| Grok (xAI) | reuses `xai.key` | `POST /v1/stt`, file last in the multipart body. |

Off by default. Having an xAI key for chat does not start sending microphone
audio anywhere; the user picks a provider under Voice in an agent's settings.

Keys follow every existing credential rule. They are write-only (reported as
booleans), kept in the OS-encrypted store in packaged builds
(`WORKSPACE_CREDENTIALS`), and injected by env
(`OMB_OPENAI_STT_KEY`, `OMB_GROQ_STT_KEY`).

Interim captions re-send the growing utterance about once a second. That is free
locally and billed in the cloud, so the harness only enables it for the local
provider (`describeStt().interim`).

## Security

- The route is not in `server/request-auth.ts`'s member list, so it is
  admin/loopback-only. Paired phones and remote pages keep the existing
  "calls are available on This computer" rule.
- It accepts only 16 kHz mono 16-bit PCM WAV up to 30 s. The endpoint cannot
  be used as a general upload proxy onto a billed account.
- There are at most 3 requests in flight. A client disconnect aborts the provider call.
- Provider error bodies are never surfaced, because they can echo credentials.

## Follow-ups

- Silero VAD behind the `Endpointer` interface for noisy rooms.
- A built-in offline model (sherpa-onnx) so "Local" needs no separate server.
- Streaming providers (xAI and Deepgram WebSockets) for sub-300 ms captions.
- Barge-in (full duplex) now that capture has echo cancellation.
