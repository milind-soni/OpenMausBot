# Voice: wake word and built-in speech

`scripts/verify-voice.ts` proves the voice surfaces end to end against the
standard isolated fixture (disposable home, fake engine, no user data):

1. The "Astra" wake-word credential round-trip: the Picovoice AccessKey saves
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

## Retired cloud STT credentials

Deepgram STT is no longer a workspace credential or server config section.
The desktop preload and main process expose no cloud dictation or call-STT
IPC. Handy's offline transcription/clipboard bridge and native macOS speech
remain available. To check bridge exposure without starting Electron or a mic:

```sh
node --test electron/preload.node-test.mjs electron/capabilities.node-test.mjs electron/local-only-hoist.node-test.mjs
```

`dictationApiKey` is not migrated into active credentials or emitted as
`ASTRA_DICTATION_KEY`; config GET/PUT responses omit `dictation`, and incoming
`dictation` patches and legacy env values are ignored. Wake-word Picovoice and
TTS credentials remain supported. This removal does not change Handy or native
macOS dictation.

Legacy raw config/store entries are not destructively deleted by unrelated
saves. `ASTRA_DICTATION_KEY` deliberately remains in child-env stripping and
diagnostics redaction: retiring a provider must not expose old secrets.

Run the focused config-only fixture (no microphone or speech-provider calls):

```sh
node --experimental-strip-types scripts/verify-voice-credentials.ts
node --test electron/workspace-credentials.node-test.mjs
pnpm exec vitest run server/config.test.ts electron/workspace-credentials.test.mjs electron/secure-credentials.test.mjs electron/diagnostics.test.mjs
```

The fixture uses the standard isolated launcher, prints its URL, PID, data
and retained log paths plus findings, and closes its own child in `finally`.
It verifies GET/PUT status, ignored legacy patches, write-only secrets, and
wake-word credential save, reload and clear plus keyless TTS settings. TTS-key
round-trips are tested at the config unit boundary, because non-empty TTS keys
trigger real provider validation through the HTTP API. A dictation-only API
patch returns `400` (`nothing to save`); mixed patches save supported fields.
The Node tests use synthetic in-memory
store/credential fixtures; Vitest uses disposable homes from the shared setup.
These checks do not verify the renderer, OS keychain or audio capture.

## What it does not prove

Renderer-only behavior — the wake-word detector arming in the pill, listening/decoding
status, the Settings → Wake word toggle markup — is not driven
by this recipe; the harness cannot click the real Settings modal. Those
surfaces are covered by unit tests (`src/lib/voice-dictation.test.ts`,
`src/lib/wake-word.test.ts`, `src/lib/local-voice.test.ts`), and the
speech-engine behavior itself by `server/tts/windows-voices.test.ts` and
`server/tts/tts.test.ts`.


## Offline capture and UI refinement

Composer microphone and wake dictation use `dictation-capture.ts`; hold
Ctrl+Space uses the same capture and copies the final transcript. Handy decodes
finished WAVs locally, not streaming partial text. The bridge creates a temporary
WAV and removes it after decoding. Handy and its downloaded speech model must be
installed separately. Native macOS speech remains supported. Wake detection
still requires a Picovoice AccessKey and initial model setup.

The libraries.dev `border-beam` and `thinking-orbs` packages were already
installed; the status pill now uses them for listening/decoding feedback with
reduced-motion handling, bounded width, and polite accessible status text.
No new animation dependency was added.

Focused regression checks:

```sh
pnpm exec vitest run src/lib/dictation-capture.test.ts src/lib/voice-dictation.test.ts src/lib/clipboard-dictation.test.ts src/lib/offline-call-stt.test.ts src/lib/offline-call-lifecycle.test.ts src/lib/wake-word.test.ts server/legacy-migration.test.ts server/tts/piper.test.ts
pnpm typecheck
pnpm build
pnpm i18n:check
```

Before release, manually smoke-test a real desktop microphone: hold/release,
Escape during permission and decode, stop-button transcription, wake detection,
and repeated call turns across bot playback. Check the reduced-motion setting.
Mocked WebAudio tests do not establish real-device recognition quality or latency.

## Handy: the desktop dictation engine

Composer dictation, wake dictation and call turns capture audio in the renderer
and hand a finished WAV to the user's own Handy install. The IPC surface is one
executable resolution plus five channels:

| Channel | Handy flag |
| --- | --- |
| `handy:toggle` | `--toggle-transcription` |
| `handy:toggle-post-process` | `--toggle-post-process` |
| `handy:cancel` | `--cancel` |
| `handy:transcribe-file` | `--transcribe-file <wav> --json [--model <id>]` |
| `handy:models` | reads `settings_store.json` and `models/`; spawns nothing |

`--model` is Astra's own pin (Settings → Wake word), not a change to Handy:
Handy owns its settings file and rewrites it on exit, so switching the engine
there would change dictation in every app on the machine. `handy:models` is
read-only for the same reason, and reports Handy's `selected_model` separately
from the models actually on disk — the two differ when a model was selected
before it finished downloading.

Executable resolution lives in `electron/handy-engine.mjs` (Settings path →
`PATH` → `%LOCALAPPDATA%\Handy` → `/Applications/Handy.app/Contents/MacOS/handy`)
and is pinned without an Electron process:

```sh
node --test electron/handy-engine.node-test.mjs electron/preload.node-test.mjs
```

Success means "the process started", exactly as upstream behaves: a second
invocation hands off to the running instance and exits, while a cold one starts
Handy and stays up, so waiting for an exit code would hang.

The Settings readout (selected model, models on disk, device advice, pinned
model) is renderer-only and not driven by the harness. Its advice tiers are
pinned by `src/lib/handy.test.ts`; the panel itself is a manual check.
