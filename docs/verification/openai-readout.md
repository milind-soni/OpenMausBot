# OpenAI reply readout

OpenAI readout uses `openai.key`, independently of ChatGPT sign-in and the
optional Live-only key. Selecting OpenAI in a bot's Voice & alerts settings
keeps the installation-wide provider scope and the bot's saved voice scope.
The first selection chooses Marin unless the bot already has an OpenAI voice;
it never enables Read replies aloud. Existing installations keep their provider.

Each existing utterance gets a fresh Realtime WebSocket with
`gpt-realtime-2.1-mini`. A session update requests audio-only 24 kHz PCM, no
tools and no microphone turn detection. After its acknowledgement, a single
out-of-band response receives only that utterance as input and instructions to
read it verbatim. Completed audio is wrapped in mono, 16-bit WAV. The existing
playback queue still owns ordering, prefetching and cancellation.

The socket has a 60-second total deadline and an 8 MiB PCM limit. It closes on
completion, error, timeout or cancellation, without retry or provider fallback.
OpenAI readout explicitly uses Node's current HTTP/HTTPS global agent so the
server's proxy configuration also applies to WebSocket handshakes. Remote
error bodies and close reasons never become logs or error responses; clients
receive a fixed English fallback and a translation key.

## Mock verification

Run from the repository root:

```sh
pnpm exec vitest run server/tts server/routes/tts-openai.test.ts server/routes/tts.test.ts src/lib/tts src/components/VoiceSettings.test.ts
pnpm exec vitest run server/config.test.ts server/voice-notes.e2e.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm exec vitest run scripts/testing/file-size-ratchet.test.ts
pnpm build
pnpm build:server
node scripts/smoke-packaged-server.mjs
```

The WebSocket tests use a loopback server and fake keys. They cover session
configuration, exact text delivery, chunk concatenation, WAV headers, invalid
voices, missing keys, 401/403/429, remote errors, disconnects, invalid and empty
audio, the size limit, timeout and cancellation. The proxy test runs isolated
Node child processes and compares enabled and disabled proxy agents. HTTP
route tests check client disconnection and an otherwise normal request that
must remain alive while speech is being generated. Queue tests cover ordering,
stop, prefetch failures and localized error fallback. Settings tests cover bot
changes and a provider broadcast arriving before its save response.

Launch the disposable fixture as described in [the verification guide](README.md)
before checking the interface. Point a separate Vite instance at its printed
port with `OMB_PORT=<fixture-port> OMB_UI_PORT=5208 pnpm exec vite`. In the fixture,
open a bot's Voice & alerts settings in Advanced mode. Check OpenAI, its missing
key link and billing disclosure, all ten voices, Marin's initial selection,
unchanged readout toggle, and Chinese/English layouts. A fake key may be saved
to this disposable fixture to reveal the static voice list; do not press the
preview button against the real OpenAI endpoint with it.

Mock audio does not validate real speech quality or the model's adherence to
verbatim reading. Chinese fluency, mixed numbers/English and faithful readout
require a person to configure an API key and explicitly preview speech. API
availability, permissions and usage charges remain OpenAI's responsibility.

Protocol reference: [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).
