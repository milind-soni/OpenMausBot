# Voice: wake word and built-in speech

`scripts/verify-voice.ts` proves the voice surfaces end to end against the
standard isolated fixture (disposable home, fake engine, no user data):

1. The "Luna" wake-word credential round-trip: the Picovoice AccessKey saves
   through `PUT /api/config`, the status reports `wakeWord.configured: true`,
   and no response ever echoes the secret back.
2. The built-in (zero-key, offline) voice engine really synthesizes: the
   recipe selects the `system` provider the same way the Settings toggle
   does, then posts to `/api/tts/speak` and requires actual WAV bytes.
3. The Piper (offline neural) provider stays honest when its engine is
   absent — the fixture home never has one — reporting `provider: "piper"`
   and refusing with Piper-specific advice rather than a silent ElevenLabs
   fallback.

On macOS the engine is `/usr/bin/say`; on Windows it is SAPI driven through
`System32\WindowsPowerShell\v1.0\powershell.exe` (resolved absolutely, so
hermetic PATHs cannot break it). On any other platform the recipe asserts
the provider refuses instead of half-working.

## Run

```sh
node --experimental-strip-types scripts/verify-voice.ts
```

Keep the printed JSON: `findings` is the evidence, and the fixture's
disposable data directory and log path identify the run. The launcher stops
its own child and removes only its temporary directory on completion.

## What it does not prove

Renderer-only behavior — the wake-word detector arming in the pill, live
partial transcripts, the Settings → Wake word toggle markup — is not driven
by this recipe; the harness cannot click the real Settings modal. Those
surfaces are covered by unit tests (`src/lib/voice-dictation.test.ts`,
`src/lib/wake-word.test.ts`, `src/lib/local-voice.test.ts`), and the
speech-engine behavior itself by `server/tts/windows-voices.test.ts` and
`server/tts/tts.test.ts`.
