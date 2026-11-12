# Handoff: telephony, voice and sub-bot work

Everything an agent taking over this branch needs, in one place. Written
for any model on any harness; nothing here depends on the session that
produced the work.

## Where the work is

Branch `claude/openmaus-audit-completion-21e545`, two commits:

- `d3ab249dd` — Telephony, tiered OpenRouter routing, LiveKit voice worker
  and sub-bot spawner (about 25 files, +2511 lines)
- `4d8408be3` — Docs: prompt for the agent architecture chart

The same commits are also on `claude/modest-heisenberg-a377e3` (the
`quirky-galileo-279869` worktree of the same repository). Neither branch is
pushed to origin at the time of writing; work from another machine requires
a push first. Remote: `milind-soni/OpenMausBot`.

## What is implemented and where

- **Tiered OpenRouter router** — `server/llm/openrouter.ts`. Four tiers
  (live / background / brain / specialist), each a primary model with a
  fallback chain; a request falls to the next model on 408/409/429/5xx.
  Model ids are plain strings in that file; swapping in another model is an
  edit there (voice worker: `VOICE_LIVE_MODEL`, see below). Key resolution:
  `OMB_OPENROUTER_API_KEY` wins over `OPENROUTER_API_KEY`.
- **Telephony door** — `server/telephony/door.ts`, mounted beside the
  pre-existing bot API door in `server/index.ts`. Verifies
  `X-Twilio-Signature` (`server/telephony/signature.ts`) over every Twilio
  webhook; owner calls get `<Dial><Sip>` to LiveKit when configured, a
  Twilio `<Gather>` speech loop (20-turn cap) when not; strangers get
  voicemail recorded as a fact. Also exposes a bearer-token ingest
  (`/hooks/telephony/ingest`, token `TELEPHONY_INGEST_TOKEN`) for the voice
  worker to record call turns and facts.
- **Twilio REST** — `server/telephony/service.ts` (sendSms, placeCall) and
  `server/telephony/store.ts` (the cross-channel memory: facts, call turns,
  SMS; atomic writes, every write secret-redacted).
- **App routes + approval gates** — `server/routes/telephony.ts` behind the
  app auth: status, lists, memory, outbound SMS/calls. Outbound is refused
  (403) without an explicit approval; approving a drafted SMS reply by id is
  itself the approval. Defaults: `TELEPHONY_SMS_AUTOREPLY=ask`,
  `TELEPHONY_OUTBOUND_POLICY=ask`.
- **Sub-bot spawner** — `server/llm/subbots.ts` + `server/routes/subbots.ts`.
  The Tier-3 brain designs a persona from a name+purpose; one atomic JSON
  file per bot in `DATA_DIR/subbots/<id>.json` (hot-swappable); questions are
  answered on the specialist tier with the cross-channel memory as context.
- **LiveKit voice worker (Python)** — `voice-worker/agent.py` with
  `voice-worker/requirements.txt` and `voice-worker/README.md`. Silero VAD
  (barge-in on) → Deepgram nova-3 STT → OpenRouter live tier → spoken-text
  cleanup → Deepgram aura-2 TTS (`aura-2-asteria-en`; no voice cloning).
  A `remember` tool posts facts to the ingest door.
- **Env documentation** — `.env.example` names every key the above reads.

## How to verify before changing anything

The rule in `AGENTS.md` is binding: verify only against an isolated fixture,
never against a person's running app or data.

```sh
pnpm typecheck          # tsc -b && tsc -p tsconfig.server.json
pnpm lint               # oxlint --deny-warnings .
npx vitest run server/telephony/door.test.ts server/routes/telephony.test.ts server/llm/subbots.test.ts server/llm/openrouter.test.ts
node --experimental-strip-types scripts/control-omb.ts launch
# second terminal, with the URL the launcher prints:
pnpm control:omb doctor --url http://127.0.0.1:PORT
```

Stop the fixture with Ctrl-C; it removes only its own temporary data.
Verification recipes live under `docs/verification/`.

## Not wired to the real world yet

The code is complete and tested against fixtures; going live still needs:

1. `TELEPHONY_PUBLIC_URL` — the public base of the webhook receiver as
   Twilio dials it (scheme, host, port — e.g. through a cloudflared tunnel).
2. Twilio console: point the number's **voice** webhook at
   `{TELEPHONY_PUBLIC_URL}/hooks/telephony/voice` and **SMS** at
   `/hooks/telephony/sms`.
3. A LiveKit server with a SIP trunk + dispatch rule; put the dispatch
   URI in `LIVEKIT_SIP_URI`.
4. `TELEPHONY_INGEST_TOKEN` in the app's env and the same token in
   `voice-worker/.env` with `TELEPHONY_INGEST_URL`.
5. API keys: OpenRouter (`OPENROUTER_API_KEY` or `OMB_OPENROUTER_API_KEY`),
   Deepgram (`DEEPGRAM_API_KEY` or `OMB_DEEPGRAM_API_KEY`), Twilio
   (`TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` or the API-key pair),
   `TWILIO_PHONE_NUMBER`, `USER_AUTHORIZED_PHONE_NUMBER`.
6. The worker itself: `pip install -r voice-worker/requirements.txt` then
   `python voice-worker/agent.py dev` (see `voice-worker/README.md`).

## Invariants for whoever takes over

- Follow `AGENTS.md` in full: the comments policy, and the isolated-fixture
  verification rule above all.
- Outbound SMS and calls stay behind their approval gates. Do not add a
  path that sends without one.
- Everything written to the telephony store passes the shared redaction
  helper. Do not write raw text around it.
- Never commit `.env`, `.env.cloudflare` or any key material; key names
  only, as `.env.example` does.
- No voice cloning. The phone voice is aura-2 and stays a Deepgram voice.
- The bot's model tiers do not include the free NVIDIA models; those were
  deliberately kept out of the tier chains.
