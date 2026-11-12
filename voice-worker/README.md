# OpenMausBot voice worker

The LiveKit worker that answers phone calls with Deepgram's ears and voice and an
OpenRouter live-tier brain. The app's telephony door bridges the owner's Twilio call
into LiveKit SIP; this worker picks it up.

- **Ears**: Deepgram `nova-3` streaming STT
- **Turn detection**: Silero VAD, with barge-in (interrupting the bot cancels its speech)
- **Brain**: `openai/gpt-6-luna` over OpenRouter (`VOICE_LIVE_MODEL` to change)
- **Voice**: Deepgram aura-2 (`VOICE_TTS_MODEL`, default `aura-2-asteria-en`)
- **Memory**: every caller and bot turn, plus anything the bot saves with its
  `remember` tool, is posted to the app's ingest door and lands in the same
  cross-channel store as desktop chat and SMS

No voice cloning is used; the bot speaks with an aura-2 voice.

## Keys

Set these in `.env` (the app reads the same file):

```
OMB_OPENROUTER_API_KEY=...      # or OPENROUTER_API_KEY
DEEPGRAM_API_KEY=...            # or OMB_DEEPGRAM_API_KEY
LIVEKIT_URL=...                 # ws://localhost:7880 for a local server
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
TELEPHONY_INGEST_URL=http://127.0.0.1:<webhook-port>/hooks/telephony/ingest
TELEPHONY_INGEST_TOKEN=<same token as the app's .env>
VOICE_LIVE_MODEL=openai/gpt-6-luna
VOICE_TTS_MODEL=aura-2-asteria-en
```

## Run

```bash
cd voice-worker
pip install -r requirements.txt
python agent.py dev
```

To take Twilio calls, point the app's `LIVEKIT_SIP_URI` at a LiveKit SIP dispatch
rule that routes to this worker (LiveKit Cloud: SIP trunk → dispatch rule → agent).
Desktop and iPhone WebRTC clients dial into the same room, so they reach the same
worker, memory and tools.
