# Speech input

In Settings → General → Speech input, choose OpenAI-compatible server, then
OpenAI, Groq, or Custom or local server. Set the API base URL; one with no path
(`http://localhost:8000`) gets `/v1`. The OpenAI and Groq presets need a key; any
other server is used without one when the key is left blank. A key is sent only
to an https address or to a server on this computer (localhost, 127.0.0.1,
::1); saving one for another plain http address is refused. Click **Load models**, then
choose or type a transcription model ID. Models are discovered from that
server's `/models` endpoint; there is no fixed model default or allowlist.
The catalog can include models without speech support, so choose one supporting
the provider's transcription API. Manual entry works if discovery is unavailable.
Save speech input, then use the composer microphone or a Take turns call.
The service must implement `POST /audio/transcriptions` with multipart `file`
and `model` fields and a JSON response containing `text`. Chat-only models
and servers without that audio endpoint cannot transcribe recordings.

For a local Whisper server, use its actual API root, for example
`http://localhost:8000/v1`, and the model name that server accepts. The server
must already be running; this provider does not download or embed a speech model.
On a remote workspace, localhost refers to the workspace server's computer.
Recordings go only to the selected transcription service; there is no automatic
fallback to a different service after a failure. Transcription and spoken-reply
providers are independent.

For fully offline or private transcription, install any speech model the
person likes behind a server that implements `POST /audio/transcriptions` (for
example speaches, LocalAI, or whisper.cpp's server with an OpenAI-compatible
path), start it on the computer running OpenMausBot's server, and choose Custom
or local server with its address, such as `http://localhost:8000`, and no key.
Audio then never leaves that computer.

Automatic preserves Apple Speech in the Mac app and Fish Audio elsewhere,
browsers included. Any explicit selection uses the page recorder on macOS too.
A browser page records only when it is a secure page (https or localhost);
elsewhere Take turns asks for the desktop app. This setting controls in-app
dictation and Take turns calls; the macOS global talk shortcut uses its native
speech helper, and Live calls retain their separate audio engine.

Packaged desktop saves use the OS-backed credential store. Other server setups
keep the key in their private config. Changing the API root revokes the old key,
including a copy the desktop might inject after a restart. Save a new key for
the new endpoint. No chat-provider key is reused. Provider failures expose a
sanitized error, and uploads are bounded to 12 MiB and failed requests are not retried.

Run the isolated checks:

```sh
node node_modules/vitest/vitest.mjs run server/stt-config.test.ts server/stt.e2e.test.ts server/routes/tts.test.ts src/components/SpeechInputSettings.test.ts src/lib/speech.test.ts src/lib/recorded-speech.test.ts src/lib/use-composer-dictation.fish.test.ts
node --test electron/workspace-credentials-save.node-test.mjs electron/credential-patch.node-test.mjs
```

The server test launches `launchVerificationServer` with a temporary home and a
fake engine. An owned loopback transcription server inspects the actual HTTP requests.
It checks the model, WAV upload, credentials, keyless operation, saved settings,
endpoint changes, sanitized errors and external credential storage. A restart
with a synthetic stale OS credential verifies that it stays revoked. The fixture records its URL, data
directory and persistent log path; a companion `.stt.json` contains redacted
verification evidence; `.stt-restart.json` records the restart checks. Cleanup
removes only the fixture home and processes.

Model discovery is an admin-only `POST /api/tts/models` using an HTTP request to the
server's `/models` endpoint. A draft key is used only for that request; it is never saved by
discovery. Saved keys are reused only for their bound API root.
The fixture checks multiple OpenAI and Groq catalog entries, new model
IDs, keyless local discovery and unchanged saved configuration. A companion
`.stt-models.json` records these checks without keys. No audio inference is
performed to load a catalog.

Renderer tests mount the real settings form and check presets, separate keys,
keyless local setup, errors and the desktop credential-save order. Recorder
tests exercise synthetic microphone frames, finishing, cancellation, and late
responses. They do not prove microphone permissions, audio quality, OS-store
encryption or access to an actual cloud account or local Whisper installation.

For a manual desktop check, save a real compatible endpoint, dictate and finish
a sentence, and check its text in the composer before sending. Repeat in a Take
turns call. Check OpenAI and Groq presets with their own keys, then a local server
with its network disabled. Switch back to Automatic on macOS and check native
dictation. Verify a rejected key gives a readable error without exposing the key.
Run a local Whisper server, select it by its
localhost address without a path or key, disconnect the network and dictate.
Open the server's page in a browser (localhost or https) and take turns with a
compatible server selected.
