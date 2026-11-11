# Gemini speech

Run the offline provider and isolated server fixtures:

```sh
node node_modules/vitest/vitest.mjs run server/tts/gemini.test.ts scripts/testing/key-readback.e2e.test.ts
```

The server fixture uses `launchVerificationServer`, a temporary home and the
fake engine. It restarts only that child with `OMB_GEMINI_TTS_API` pointing to
a loopback stand-in. No Google account, real credential or microphone is used.

The checks save and remove the Gemini key through `/api/config`, including
external credential storage, and verify masked status in the real Keys row.
They select Gemini, read `/api/tts/voices`, synthesize with a bot voice override
through `/api/tts/speak`, and verify WAV bytes and content type. Switching from
Chatterbox clears its model and voice selection. The provider tests also cover
the Interactions request contract, invalid audio and sanitized provider errors.
The server test logs its fixture URL, data directory and persistent log path.

The transport follows Google's current
[Gemini 3.8 speech contract](https://aistudio.google.com/docs/speech-generation):
`POST /v1beta/interactions`, a verbatim text input, single-speaker speech config
and WAV output.

For a manual desktop check, select Gemini under the bot's Voice settings, save
a Google AI Studio API key, select either Gemini 3.8 speech model, choose a voice
and play the sample. Enable spoken replies, send a message, and request a voice
note. Check another voice and both models. This verifies real Google access,
audio playback and subjective quality, which the offline fixture cannot prove.
The existing separate OpenAI Live call engine is unchanged; Gemini is available
where speech uses the configured TTS provider.
