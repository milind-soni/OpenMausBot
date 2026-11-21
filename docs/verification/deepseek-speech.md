# DeepSeek speech

Run the offline provider and isolated server fixtures:

```sh
node node_modules/vitest/vitest.mjs run server/tts/deepseek.test.ts server/routes/tts.test.ts src/lib/speech.test.ts src/components/VoiceSettings.test.ts scripts/testing/key-readback.e2e.test.ts
```

The server fixture uses `launchVerificationServer`, a temporary home and the
fake engine. It restarts only that child with `OMB_DEEPSEEK_SPEECH_API` pointing
to a loopback stand-in. No DeepSeek account, real credential or microphone is
used.

The isolated check saves the DeepSeek key through `/api/config` (the same
`deepseek.key` the DeepSeek engine uses), selects DeepSeek and sees Stella as
the default voice, lists exactly Stella and Tide, saves Tide and reads it back.
It synthesizes through `/api/tts/speak` with a Stella override and verifies the
WAV bytes, content type and the request body (`text`, `voice_id`, `format`,
`filter_markdown` only). A bot voice from another catalog falls back to the
workspace's DeepSeek voice. A provider refusal returns 502 without the spoken
text. A synthetic 16 kHz PCM WAV posted to `/api/tts/transcribe` reaches
`/tools/asr` as the multipart `file` and returns its text. A 121-second clip
and a non-WAV body are refused before any provider request. Removing the key
turns transcription into a 409 asking for a DeepSeek key, with no fallback to
another provider; saving it again recovers. Switching to Fish Audio clears the
voice and returns transcription to the Fish/ElevenLabs order. The server log
never contains the key.

The unit suites cover cancellation, bounded and truncated audio, malformed
transcripts, input limits, safe errors, the Mac using the page recorder while
DeepSeek is the voice, the 115-second recording cap with 64 ms frame rounding,
and the Voice settings picker.

Contract: [TTS](https://api-docs.deepseek.com/guides/tts/) and
[ASR](https://api-docs.deepseek.com/guides/asr/).

For a manual desktop check, save a DeepSeek key under Settings → API keys,
choose DeepSeek in a bot's Voice settings, pick Tide and play the sample.
Enable spoken replies, send a message, and request a voice note. Dictate into
the composer and take a turn in a call, on macOS and on Windows. This verifies
real DeepSeek access, microphone capture, playback and quality, which the
offline fixture cannot prove.
