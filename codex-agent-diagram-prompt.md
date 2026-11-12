# Prompt for Codex: build a visual web chart of the OpenMausBot agent

Copy everything below the line into Codex.

---

Build a single, self-contained HTML file (inline CSS/JS only, no external
dependencies, no build step) named `agent-architecture-chart.html` that renders
an interactive architecture diagram of the OpenMausBot voice agent described
below. Open it directly in a browser and it works.

## What the chart must show

A swimlane-style diagram with four lanes left-to-right, with animated arrows
for the data flows:

**Lane 1 — People & phones**
- "Benny (owner)" phone icon
- "Stranger" phone icon
- "Desktop / iPhone WebRTC client"
- "Benny in the app" (chat UI, behind auth)

**Lane 2 — Edge (public, untrusted)**
- "Twilio" (the bot's phone number: calls + SMS)
- "Webhook receiver" — box with two doors inside:
  - "Bot API door" (pre-existing)
  - "Telephony door" (`/hooks/telephony/*`, label: "X-Twilio-Signature verified;
    bearer-token ingest for the voice worker")
- "LiveKit server (SIP trunk + dispatch rule)" — bridges the owner's call into
  the voice worker; also serves desktop/iPhone WebRTC

**Lane 3 — Brains (OpenRouter, 4 tiers)**
- Tier 1 "LIVE voice": `openai/gpt-6-luna` (reasoning: none) → fallback
  `qwen/qwen3.8-flash` — label "sub-500ms, plain spoken text"
- Tier 2 "BACKGROUND email/SMS/call screening": `deepseek/deepseek-v4.1-flash`
  → fallbacks `z-ai/glm-5.3-flash`, `openai/gpt-6-luna` (1M-token summaries)
- Tier 3 "BRAIN orchestrator & sub-bot spawner": `z-ai/glm-5.3` → fallback
  `moonshotai/kimi-k3.1-pro`
- Tier 4 "SPECIALIST sub-bots": `deepseek/deepseek-v4.1-flash` → fallbacks
  `minimax/minimax-3.1-flash`, `z-ai/glm-5.3` (complex diagnostics escalate to
  Tier 3)

**Lane 4 — App core (trusted, behind auth)**
- "Cross-channel memory store" (`telephony/store.json`): one cylinder labeled
  with what it holds — facts, call turns, SMS, drafts — and "every write is
  secret-redacted"
- "App routes" box: `/api/telephony/*` (status, lists, SMS approve/reject,
  outbound calls/SMS) and `/api/subbots/*` (spawn, list, hot-swap, ask)
- "Outbound gates" padlock icon: label "outbound SMS + calls need an explicit
  approval (default: ask)"
- "Sub-bot files" (`DATA_DIR/subbots/<id>.json`, one file per specialist,
  hot-swapped, e.g. "Auto Mechanic")

**Lane 5 — Voice worker (Python, `voice-worker/agent.py`)**
- "LiveKit AgentSession": Silero VAD (barge-in) → Deepgram nova-3 STT →
  OpenRouter LIVE tier → speakable() text cleanup ("strips markdown, links,
  emoji") → Deepgram aura-2 TTS (voice: aura-2-asteria-en)
- "remember() tool" → posts facts to the ingest door

## Flows to draw as arrows (number them)

1. **Owner calls Twilio number** → Twilio → webhook receiver → telephony door
   (signature verified, caller ID must match the owner's number exactly) →
   `<Dial><Sip>` to LiveKit → dispatch rule → voice worker → Tier 1 answers,
   speech out through aura-2; turns + remembered facts flow back through the
   ingest door into the memory store. Mark this the "primary call path".
2. **Owner calls, no SIP configured** → telephony door keeps the call on
   Twilio `<Gather>` speech loop → each spoken turn → Tier 1 (live) →
   sanitized text back as TwiML `<Say>`; 20-turn cap ends the call.
3. **Stranger calls** → voicemail: transcription stored as a fact. No LLM.
4. **Owner texts** → door records SMS → Tier 2 (background) drafts a reply →
   DRAFT goes to the app for approval (default "ask" mode; "allow" mode sends
   it). Arrow must pass through the approval gate.
5. **Outbound from the app** → human clicks approve → gate unlocks → Twilio
   REST API sends the SMS or places the call (call webhook points back at the
   telephony door's outbound voice URL with the objective).
6. **Spawn a sub-bot** → app route → Tier 3 (brain) designs a persona → JSON
   file saved → next question answered by Tier 4 with the persona + the
   cross-channel memory as context; complex diagnostics escalate to Tier 3.
7. **Desktop/iPhone WebRTC** → LiveKit → same voice worker, same memory, same
   tools as the phone path.

## Interactions

- Clicking any box shows a detail panel with its exact file path(s) and
  responsibility (paths below).
- Clicking a tier shows its model, fallback chain and reasoning effort.
- A legend separating: solid arrows = live audio/text flow, dashed =
  control/approval flow, red = refusal paths (unsigned webhook → 401, no
  approval → 403, non-owner → voicemail).
- Dark-mode friendly, responsive, and printable.
- No placeholder text; every label above must appear.

## File paths to use in the detail panels

- `server/llm/openrouter.ts` — the 4-tier OpenRouter router + fallback chains
- `server/telephony/door.ts` — TwiML door on the webhook receiver + ingest
- `server/telephony/service.ts` — Twilio REST (sendSms, placeCall) + config
- `server/telephony/signature.ts` — X-Twilio-Signature HMAC check
- `server/telephony/store.ts` — cross-channel memory store (atomic, redacted)
- `server/routes/telephony.ts` — app routes + outbound approval gates
- `server/routes/subbots.ts`, `server/llm/subbots.ts` — sub-bot spawner
- `server/tts/deepgram.ts` — Deepgram STT/TTS client used by the app
- `voice-worker/agent.py`, `voice-worker/requirements.txt` — the LiveKit worker
- `server/index.ts` — mounts the door beside the bot API door on the receiver

Output exactly one HTML file. Do not invent components beyond this list.
