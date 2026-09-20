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
4. The section convention as the voice sees it: `POST /api/tts/prepare` on a
   reply with headings returns its lead only, with nothing from the sections
   under it spoken, and an unheaded reply falls back to its first paragraph.
5. Tool-leak stripping: a reply that is a bare computer-action payload plus
   narration (`{ "action": "press", "keys": ["win", "r"] }`, "We need to
   output tool use calls.") produces no utterances at all, and prose written
   around such a payload is spoken without it. Fenced JSON examples stay
   untouched — that is code the reader asked for.

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

Recorded run (Windows, isolated fixture): an 81,486-byte WAV from the platform
engine; Piper refusing with a 409 that names Piper; `tts prepare` answering
`The redirect is fixed and the suite passes.` for a headed reply — with
`query string` and `auth.ts`, both of which are in that reply, absent from the
utterances — and `Tests pass.` for the unheaded one; a pure-leak reply
("") silent and `Opening the Run dialog.` surviving with its payload
dropped.

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
status, the Settings → Voice & Handy toggle markup — is not driven
by this recipe; the harness cannot click the real Settings modal. Those
surfaces are covered by unit tests (`src/lib/voice-dictation.test.ts`,
`src/lib/wake-word.test.ts`, `src/lib/local-voice.test.ts`), the settings
section's own markup by `src/components/SettingsModal.voice.test.ts`, and the
speech-engine behavior itself by `server/tts/windows-voices.test.ts` and
`server/tts/tts.test.ts`.

The reader's half of the same convention — that a settled reply renders as its
lead plus a fold row, and that the detail is not in the DOM until it is
opened — is not driven here either. The [chat UI recipe](chat-ui.md) is where
it would belong, and its pinned agent-browser download is not available in
every environment; it is pinned instead by `src/components/ReplySections.test.ts`
(the fold) and `src/components/ChatView.replySections.test.ts` (the real
transcript reaching it), and the split itself by `shared/reply-sections.test.ts`
and `server/tts/speech-text.test.ts`.


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
# what is spoken at all, and what the reader is shown: the section convention
pnpm exec vitest run shared/reply-sections.test.ts server/tts/speech-text.test.ts server/system-prompt.test.ts src/lib/tts/index.test.ts src/components/ReplySections.test.ts src/components/ChatView.replySections.test.ts
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
executable resolution plus three channels:

| Channel | Handy flag |
| --- | --- |
| `handy:toggle` | `--toggle-transcription` |
| `handy:transcribe-file` | `--transcribe-file <wav> --json [--model <id>]` |
| `handy:models` | reads `settings_store.json` and `models/`; spawns nothing |

`handy:toggle` drives Handy's own recorder, and is the bridge's only control over it:
dictation and call turns capture in the renderer and post a finished WAV, so they
never toggle or cancel Handy's recording.

`--model` is Astra's own pin (Settings → Voice & Handy), not a change to Handy:
Handy owns its settings file and rewrites it on exit, so switching the engine
there would change dictation in every app on the machine. `handy:models` is
read-only for the same reason, and reports Handy's `selected_model` separately
from the models actually on disk — the two differ when a model was selected
before it finished downloading.

Handy's own state is read from Tauri's app data directory:
`%APPDATA%\com.pais.handy` on Windows,
`~/Library/Application Support/com.pais.handy` on macOS, and
`$XDG_DATA_HOME` (or `~/.local/share`)/`com.pais.handy` on Linux. Only the Linux case
differs from Electron's own appData, so the directory is derived in `handy-engine.mjs`
rather than handed in by the shell. Executable resolution lives there too: the
Settings path, else `PATH`, else the platform's standard install location
(`%LOCALAPPDATA%\Handy` on Windows, the `Handy.app` bundle on macOS, and the bare
`handy` on Linux, where the packaged app has no single install location to guess at).
It is pinned without an Electron process:

```sh
node --test electron/handy-engine.node-test.mjs electron/preload.node-test.mjs
```

Success means "the process started", exactly as upstream behaves: a second
invocation hands off to the running instance and exits, while a cold one starts
Handy and stays up, so waiting for an exit code would hang.

The Settings readout (selected model, models on disk, device advice, pinned
model) is renderer-only: it is drawn from the bridge above, so the shared
control surface cannot reach it. Its advice tiers are pinned by
`src/lib/handy.test.ts`, and the panel itself is photographed on a fixture —
see [Pictures of both panels](#pictures-of-both-panels).

## Pictures of both panels

Two surfaces in this feature cannot be driven by the control surface, because
neither is reachable from it: the readout above, and the one-click Piper offer
inside the agent voice panel. `scripts/verify-voice-ui.ts` photographs both,
from the shipped components, on the standard isolated fixture — the same
launcher, a disposable home, and a disposable browser driven over CDP:

```sh
node --experimental-strip-types scripts/verify-voice-ui.ts
# ASTRA_CAPTURE_CHROME=/path/to/chrome overrides the browser it drives
```

It mounts `scripts/testing/voice-preview.tsx`, which renders the real
`SettingsModal` (Connections, where the wake-word card lives) and the real
`VoiceSettings` through the real store and the real config API. The one
synthesized part is the desktop bridge, which does not exist outside Electron:
the Handy snapshot handed to it is measured here *by* `electron/handy-engine.mjs`,
so on a machine with Handy installed the readout is drawn from the real selected
model, the real models folder and Handy's real `--list-models` catalog.

Recorded run (Windows, isolated fixture, headless Chrome):

| Picture | What it shows |
| --- | --- |
| [`handy-engine-dark.png`](evidence/voice/handy-engine-dark.png) and [`handy-engine-light.png`](evidence/voice/handy-engine-light.png) | Settings → Connections → Dictation engine: "Handy's model: Canary 180M Flash", the models it can run, this machine's advice and verdict, and the pin — on the dark and light skins |
| [`piper-install-offer.png`](evidence/voice/piper-install-offer.png) | the agent voice panel before the install: the engine radios with Piper listed but unavailable, and the one-click offer |
| [`piper-installing.png`](evidence/voice/piper-installing.png) | the same button mid-install, which is the state the config frame reports |
| [`piper-installed.png`](evidence/voice/piper-installed.png) | Piper selected, the offer gone, and the voice it brought ("Amy — offline neural voice — medium quality") ready to try |

The run installs through the real route — `POST /api/tts/piper/install`, the
hash-pinned download, the host's own `~/.astra/piper` untouched — and the engine
it pictured then returns a real 22.05 kHz WAV from `/api/tts/speak`: about 3.4 s
of audio (147,144 bytes on one run, 148,680 on the next), because Piper's sampler
is not bit-reproducible. `findings.json` beside the pictures is the newest run's
own report, and the pictures themselves come out byte-identical every time, which
is what makes them usable as before/after evidence.

These pictures are worth exactly this much: they prove the panels render the real
data honestly, down to naming `parakeet-tdt-0.6b-v2` ("Parakeet V2") rather than
the `parakeet-tdt-0.6b-v2-int8` folder on disk, because only a catalog id is
something `--model` accepts. They do not prove the Electron side of the bridge:
the real IPC and preload are pinned by
`electron/handy-engine.node-test.mjs` and `electron/preload.node-test.mjs`.

## Provisioning Piper (offline neural speech)

Piper is per machine: an absent engine is reported, never worked around. There
are two ways to get it, and both end in the same `~/.astra/piper` layout.

**From Settings** — `POST /api/tts/piper/install` answers `202` and installs the
engine plus `en_US-amy-medium` in the background, reporting progress through the
config frame (`tts.piperInstalling` / `tts.piperInstallError`) exactly like the
browser engine's install. Every artifact is pinned to a SHA-256 in
`server/tts/piper-install.ts` and is refused if the hash does not match, and
`tts.piperInstallable` is false on targets piper publishes no build for
(Windows on arm64), where the docs below are still the answer.

Two invariants sit behind that route, both learned the hard way:

- **The engine lands last.** Availability keys on the engine binary, so the
  voice files are downloaded first; an install interrupted mid-flight reports
  "not installed" rather than a usable engine with no voice.
- **The staging directory is never left behind**, so a retry starts clean.

**By hand** — on Windows, with the data directory at `~/.astra`:

```sh
curl -sL -o /tmp/piper.zip https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip
unzip -q /tmp/piper.zip -d /tmp/piper-extract
mkdir -p ~/.astra/piper/voices && cp -r /tmp/piper-extract/piper/. ~/.astra/piper/
curl -sL -o ~/.astra/piper/voices/en_US-amy-medium.onnx \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
curl -sL -o ~/.astra/piper/voices/en_US-amy-medium.onnx.json \
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
```

Voice choice is a speed decision on a laptop: measured on a 4-core i7-8550U
with no GPU, `en_US-amy-medium` synthesized 4.16s of audio in 0.96s (real-time
factor 0.23), while the `high` tier is more natural and slower.

With the engine present, `GET /api/config` must report `tts.piperAvailable:
true`, `tts.ready: true`, and `POST /api/tts/speak` must return real WAV bytes.
Prove it on a disposable fixture rather than the user's install. Either install
into the fixture with `POST /api/tts/piper/install` and poll until
`tts.piperAvailable` is true, or (offline) copy a provisioned `piper/` into the
printed `dataDir` — availability is evaluated per request. Then PUT
`{ tts: { provider: "piper", voice: "en_US-amy-medium" } }`, require
`GET /api/tts/voices` to list the voice, and require `RIFF` bytes back from
`/api/tts/speak`.

Recorded run (Windows, 4-core i7-8550U, isolated fixture): `202` on install,
`piperInstalling` observed mid-flight, `piperAvailable` true with no error, the
voice listed as `en_US-amy-medium` ("Amy"), and a real 131,784-byte 22.05 kHz
WAV (2.99 s) from `/api/tts/speak` — with the host's own `~/.astra/piper`
untouched. The same route is photographed end to end in
[Pictures of both panels](#pictures-of-both-panels).

`scripts/verify-voice.ts` deliberately asserts the opposite case — the fixture
home has no engine, so Piper must refuse honestly — and it still passes with
Piper provisioned on the host, because the fixture cannot see it.

The installer's guard rails are pinned without a network by
`server/tts/piper-install.test.ts`: the hash gate, the refusal on unsupported
targets, the download it must not start when Piper is already installed, the
absence of a half-install after a failed voice download, and the staging
directory it must never leave behind.
