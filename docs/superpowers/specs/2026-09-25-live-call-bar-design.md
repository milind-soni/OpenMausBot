# Live calls with the chat open — desktop, iPhone and Android

Date: 2026-09-25 · Status: implemented on the desktop, iPhone and Android

## Intent

During a Live call (OpenAI GPT-Live as the voice, the bot as the brain — see
`server/live-call.ts`), the chat stays visible. The person sees what the bot is
doing — a lookup, a tool step, its answer — while they talk. The call controls
shrink to a compact **call bar** instead of covering the chat. This works the
same on the desktop app, the iPhone companion and the Android companion.

Success looks like:

- On every client, a spoken request appears in the chat (labelled "via call"),
  followed by the bot's normal activity and answer, while the voice keeps talking.
- The rules that connect voice and bot (what becomes a bot message, what the voice
  is told, spoken yes/no for approvals) exist once, on the harness, and behave
  identically for all three clients.
- A forgotten call ends by itself after 5 minutes without speech.

## Decisions

| Decision | Choice |
|---|---|
| Platforms | Desktop, iPhone **and** Android |
| Chat content during a call | Only bot work is persisted: the relayed request (labelled "via call"), activity chips and answers. The voice's own words are live captions in the call bar, never stored. |
| Phone audio path | **Direct**: phone ↔ OpenAI over WebRTC. The computer that runs the harness only creates the session and runs the logic. Both apps gain a WebRTC library. |
| Phone backgrounding | The call **ends** when the app leaves the foreground or the screen locks. Background calls are a later feature. |
| Desktop voice picker | Replaced by a **settings gear** in the call bar; voice is one setting under it. |
| Idle hang-up | After **5 minutes** without speech (configurable under the gear). |
| Take-turns mode | Unchanged (full-screen overlay, desktop only). |
| Voice persona | The voice **is** the bot: it speaks in the first person, never mentions a backend, delegation or a "voice layer", and never asks whether it may look something up — it checks (decided after the first calls, 2026-09-26). OpenAI's trained headings (`Backend tools`, `Delegate to the backend when`, …) stay in the instructions. |

## Architecture

```
 client (desktop renderer | iOS app | Android app)            OpenAI GPT-Live
   mic + speaker ── WebRTC media ────────────────────────────▶  session
   captions  ◀── data channel (transcript deltas, read-only) ──   │
   call bar  ◀── SSE `live.call` state ──┐                         │
                                         │                         │ sideband
 harness (computer)                      │                         │ wss .../attach
   POST /api/live/session ── creates session (key stays here) ─────┤
   LiveCallController ── owns the call: delegation → bot turn,  ◀──┘
                         bot activity/answer → thinking/commentary,
                         approvals → spoken yes/no, idle hang-up
   companion (phones) ── allowlists the four /api/live routes
```

### One owner per action

- **Clients** own media only: microphone capture, speaker playback, local mute,
  captions from their own data channel, and the UI. They never send context
  appends. At session creation the harness restricts the untrusted client data
  channel: `session.client.data_channel = { allowed_client_events: ["session.close"],
  allowed_server_events: [{ type: "session.started" }, { type: "session.input_transcript.delta" },
  { type: "session.output_transcript.delta" }, { type: "session.closed" }, { type: "error" },
  { type: "info" }] }` (selector objects, per the SDK's `DataChannelConfig`; this
  does not apply to the sideband).
- **The harness** owns everything else through a **sideband** WebSocket attached
  to the session (`wss://api.openai.com/v1/live/sessions/{session_id}/attach`,
  `Authorization: Bearer <live key>`; verified: Node 22 and Electron 43's Node 24
  built-in `WebSocket` send the header). It receives transcripts and delegation
  events and sends `session.{thinking,commentary,instructions}.append`.

### Harness: `LiveCallController` (new, `server/live-call-controller.ts`)

One active call per harness. Responsibilities, moved from today's renderer
`LiveCall.tsx` plus new ones:

1. **Delegation → bot turn.** On `session.delegation.created` (target `client`),
   wait ~700 ms for trailing transcript, take the words since the previous
   request (`LiveTranscript.takeRequest`, moved to `shared/`), and start an
   ordinary turn on the call's thread through the same internal path as
   `POST /api/bots/:id/messages`, marking the message `via: "call"`. Empty
   request → `instructions.append` "ask the user to repeat".
2. **Bot → voice.** Follow the thread's messages: activity chips with
   `tool.spoken` → quiet `thinking.append` (≤ 1 per 4 s); the turn's final text
   answer → speakable text (`toUtterances`, `server/tts/speech-text.ts`) →
   `commentaryChunks` (≤ 1,400 chars × 3, "The full answer is in the chat.") →
   `commentary.append` with the delegation id. A turn that ends without text →
   commentary "the result, or what went wrong, is in the chat".
3. **Approvals and questions.** A pending approval card → `instructions.append`
   with the existing spoken prompt; the next complete utterance (via delegation
   or a 1.2 s quiet window on the input transcript) is judged by
   `spokenConsent(…, "live")` (moved to `shared/`), strict yes/no only, then
   decided through the same function as `POST /api/bots/:id/respond`. A Live
   call keeps the microphone open while the voice speaks, so there "ok",
   "okay", "sure" and "fine" are hedges, never the answer ("okay, yes" still
   allows; "okay" alone asks again), and input heard while the voice itself
   spoke (when `session.output_transcript.delta` carries `start_ms`/`end_ms`)
   is left out of the answer on both paths. Take turns keeps its own rule (its
   microphone is closed while the bot talks). A card decided on the call records
   `answeredBy.via: "call"`, and its decision-log row `via: "call"` (the CSV
   export shows "(by voice)"). Skill approvals cannot be granted by voice.
   Option cards → the next request becomes the card's answer. A connect-an-app
   card or a credential card gets one spoken pointer to the chat; the voice is
   told never to ask for a credential aloud.
4. **Typed messages during a call.** A user message without `via: "call"` goes
   to the bot only; the voice is told nothing when it is typed (mirroring it made
   GPT-Live answer it at once and again when the bot's answer arrived — found in
   the first tests). When the bot answers it, the answer is relayed once as
   commentary, led by what was typed, if `readTypedReplies` is on (default on).
   With it off, nothing about a typed message reaches OpenAI: not what was
   typed, not the answer, and no progress or status notes while the bot works
   on it. Only the caller's own typed lines count: a line a client sent (every
   client sends a `sendId`), not stamped `via: "api"`, not `relayed`, whose
   `sender` is the caller (no sender for the owner on this computer and their
   paired phones). A peer bot's line (`peerAsk`: ask_bot, start_thread, or an
   `aside` folded into the running turn), another member's line, a routine's
   or webhook's line, and a line an external interface relayed for someone
   else (`POST /api/bots/:id/messages/guarded`, such as the Slack worker: it
   posts as this computer with a `sendId` of its own, so the harness stores
   that line with `relayed: true`) are not relayed at all. Lines drained from
   the queue together are one turn answering the last of them: its answer
   settles the whole batch, and a batch that holds a spoken line is answered
   aloud on the call's delegation (without the "about what you typed" lead).
5. **Status notes.** While the bot works on the call's thread, every 30 s the
   voice gets a quiet `thinking.append`: how long the bot has worked, how many
   steps, and the last step's name (never its arguments). The instructions tell
   the voice to answer "is it still working / stuck?" from the latest note
   instead of guessing or delegating (a delegated status question is steered
   into the running turn). Found in testing: the voice said "I see it is
   stuck" during a 5-minute turn it knew nothing about. With `readTypedReplies`
   off, progress and status notes are sent only while the bot works on a spoken
   request.
6. **Idle hang-up.** No input speech, no bot work in progress, and no output
   speech for `idleMinutes` (default 5) → `session.close`, end reason `idle`.
7. **Lifecycle.** Emit SSE `live.call` on every state change; `session.closed`
   or sideband loss → state `ended` with a reason; one summary line in
   `server.log` (existing `liveCallSummaryLine`). The session is created and
   `201` returned first; the sideband attaches in the background (the phone path
   has a 30 s header timeout). If the sideband cannot attach or drops, the
   harness marks the call ended and the client closes its own data channel
   (`session.close`), because a WebRTC session cannot be closed from the
   harness without the sideband. A start cancelled while OpenAI creates the
   session (a hang-up, an unpairing, a shutdown) attaches to that session only
   to send `session.close`, so no session is left open.
8. **Bound to whoever started it.** A call remembers the sign-in that started
   it and, for a phone, the paired device the companion vouched for
   (`x-openmausbot-companion-device` on `POST /api/live/session`). A phone's
   requests reach the harness as the computer's own (loopback), so only the
   companion knows when a phone is unpaired: it then sends
   `POST /api/live/device-revoked` over its authenticated relay path, and the
   harness ends that phone's call at once and refuses a start from that phone
   still in flight. A revoked or signed-out sign-in ends its call at once too
   (`sessions.onSessionRevoked`; the 15 s idle check also looks). Both end
   with reason `signed-out` and the harness's own words in `error`.

### HTTP contract (harness; the companion allowlists the first four for phones)

| Route | Body | Result |
|---|---|---|
| `POST /api/live/session` | `{ botId, threadId?, sdp, client: "desktop" \| "ios" \| "android" }` | `201 { call: LiveCallState, transport: { type: "webrtc", sdp } }` · `409 { error, needsKey: true }` without a key · `409 { error, activeCall }` when a call is running · `404` unknown bot/thread · OpenAI refusals as today (`liveErrorMessage`) |
| `POST /api/live/call/end` | `{ callId }` | `200 { call }` after `session.closed` or 5 s |
| `GET /api/live/call` | — | `200 { call: LiveCallState \| null }` |
| `PATCH /api/live/settings` | `{ voice?, readTypedReplies?, idleMinutes? }` | `200 { live: LiveSettings }` — non-secret settings only; the key is never writable from a phone |
| `POST /api/live/device-revoked` | — (headers `x-openmausbot-companion: 1` and `x-openmausbot-companion-device`; under the desktop app also the companion's private relay token) | `200 { call: LiveCallState \| null }` (the call it ended) · `403` without the companion marker · `400` without a well-formed device id. The companion's own notice that it unpaired a phone: not on the phone allowlist (`companion/src/routes.ts` `COMPANION_NOTICES`); the harness accepts it only with the relay token, or from loopback for a standalone harness |

`LiveCallState = { callId, botId, threadId, client, voice, startedAt, status: "connecting" | "live" | "ending" | "ended", endReason?, error? }`,
with `endReason` one of the codes under **End reasons**. A phone's
`POST /api/live/session` is bound to the device id the companion forwards; a
start from a phone that was unpaired is refused with `401`.
`LiveSettings = { configured, voice, readTypedReplies, idleMinutes }` (also in
`GET /api/config` as `live`). SSE: `{ kind: "live.call", botId, threadId, call: LiveCallState | null }`
(frames are keyed by `kind`; the top-level `botId`/`threadId` let the member
filter hide calls on bots a member cannot see), passed through the companion's
scrubber unchanged. A client that connects mid-call reads `GET /api/live/call`.

Config (`config.live`): `key` (secret, desktop credential store, unchanged),
`voice`, `readTypedReplies` (boolean, default true), `idleMinutes` (1–60,
default 5).

### Message label

`WireMessage.via` gains `"call"` (today `"api"`). Desktop, iOS and Android
render a small "via call" line under such a user message. `WireMessage.relayed`
marks a user line an external interface sent through the guarded send route
(no client shows it; a Live call never reads such a line back as typed).

## Desktop

- **Start:** the phone icon starts the remembered mode; a chevron next to it
  opens a menu with **Take turns** / **Live**. First Live call without a key →
  the existing key form, in a popover under the call button.
- **Media lives app-wide** (`src/lib/live-call-media.ts`, mounted once at the
  app root), so switching chats does not end the call.
- **Call bar** (in the call's chat, above the composer): bot, "Live with Ada ·
  m:ss", one caption line (the voice's words; the user's own words in grey
  while they speak), **gear**, **Mute**, **Hang up**. Errors and ends appear
  in the bar, with **Try again** only after a drop or a failed start (see
  **Client rules**). Narrow windows: icon-only buttons, caption on a second line.
- **Gear popover:** Voice · Read replies to typed messages (with what off
  means) · Hang up after N minutes of silence · OpenAI key (change / remove) ·
  the disclosure sentence and the cost.
- **Elsewhere:** in another chat, a compact pill at the bottom of the sidebar
  (back, mute, hang up) and a green phone badge on the bot's row.
- Escape no longer hangs up a Live call. Take turns is unchanged.
- A decided approval card reads "Allowed · by voice" / "Denied · by voice"
  when it was decided on the call.
- The window checks its own sign-in when its event stream drops during a
  call, and when OpenAI closes the call without an end frame: a `401` hangs
  up at once with the signed-out reason (a revoked browser sign-in has its
  stream cut and never gets the harness's end frame).

## iPhone (native SwiftUI companion)

- Dependency: a WebRTC XCFramework via Swift Package Manager (candidate
  `https://github.com/stasel/WebRTC`, BSD). App size grows by an estimated
  15–25 MB (not yet measured).
- `CompanionCore`: `startLiveCall`, `endLiveCall`, `liveCall`, `updateLiveSettings`,
  `live.call` SSE decoding, `via: "call"`.
- App: `LiveCallController` (peer connection, `AVAudioSession` playAndRecord +
  voiceChat, mute), `LiveCallBar` above the composer in `ChatView`, a thin
  banner on other screens while a call runs. Walkie mode is unchanged.
- Sound output: the speaker/earpiece choice (remembered on the phone) is used
  only when no headset is connected. A wired, USB, Bluetooth (HFP, A2DP, LE,
  which is how hearing aids connect) or car output always takes the call,
  decided again on every route change from the route iOS picked
  (`LiveCallAudioRoute`); the loudspeaker override is taken off when the call
  closes.
- Settings sheet: voice; sound output ("Applies to calls on this iPhone. A
  connected headset takes the call instead."); Read replies to typed messages
  with its description; Hang up after silence as a picker of 1, 2, 3, 5, 10,
  15, 30 or 60 minutes (one `PATCH` per choice; a value set elsewhere, such
  as 7, stays listed); the OpenAI key row "Managed on your computer" with the
  disclosure sentence under it.
- The call ends when the app goes to the background (`scenePhase ==
  .background`, which locking the screen also reaches), not on `.inactive`:
  iOS reports that for Control Center, the app switcher, a call banner and
  the microphone prompt itself. An audio interruption (a phone call, Siri)
  ends it too. Both leave no notice.
- Before the first Live call on the phone: the disclosure, once (see
  **Client rules**). Microphone permission reuses the existing usage
  description.
- When the computer stops taking the phone (unpaired, token refused), the
  phone hangs up at once (`session.close` on its own channel) and its
  unpaired screen shows "Call ended: you were signed out."; a deliberate
  sign-out or a switch of computer hangs up quietly.

## Android (native Compose companion)

- Dependency: a prebuilt libwebrtc AAR (candidate `io.github.webrtc-sdk:android`,
  BSD); hardware AEC via `JavaAudioDeviceModule`.
- `:core`: the same four calls, `live.call` decoding, `via: "call"`.
- `:app`: `LiveCallManager`, call bar in `ChatScreen`, settings bottom sheet,
  banner elsewhere, end on the process's `ON_STOP` (700 ms debounced, so a
  rotation does not hang up; it leaves "Call ended." without Try again),
  `RECORD_AUDIO` permission (already used for dictation). First calling
  feature on Android.
- The bar follows **Client rules**: "Connecting…" until the computer reports
  the call attached and the data channel is open, the clock from that moment
  on the phone; "Hanging up…" until the computer confirms (8 s at most).
  Losing the audio focus to another app ends the call ("Call ended: another
  app took the audio.", not a drop).
- Settings bottom sheet: the disclosure sentence first, then sound output
  (the speaker choice is kept on the phone), the voices, Read replies to
  typed messages with its description, and the idle minutes.
- Before the first Live call on the phone: the disclosure, once (see
  **Client rules**).
- A lost pairing (unpaired, signed out, token refused) hangs the call up at
  once with "Call ended: you were signed out." and no Try again; a switch to
  another computer leaves the call behind quietly, with no bar or notice.
- Voice notes and voice previews ask for the audio through one gate
  (`AudioFocusGate`), which refuses while the call holds the audio.

## Client rules (all three clients)

The desktop, iPhone and Android apps follow the same rules for the call they
hold and the line they show:

- **Hang-up:** after Hang up, the bar says "Hanging up…" until the computer
  confirms the end, and the end is quiet. Only the device whose Hang up asked
  for it does this: an end it did not ask for (another device hung up, the
  computer ended the call) keeps the call's title and clock while the call
  is `ending`, then shows the reason's words (a hang-up from another device
  reads "Call ended.").
- **Remote bar:** a call held by another device shows a bar with Hang up in
  that call's chat; it is hidden once that call is ending or ended.
- **Call button:** hidden while another device holds the line (any status but
  `ended`), in every bot's chat. On the desktop only a button that would
  start a Live call is hidden: in Take turns mode it starts a Take-turns
  call, which never uses the Live line, and a Take-turns call already
  running keeps its Hang up.
- **Try again:** offered only after a dropped call (a reason in the Dropped
  column under **End reasons**, or the client's own drop) and after a refused
  or failed start, on every client (the desktop's `canRetry: notice.dropped`).
  Every other end offers only the dismiss cross, whatever words it carries;
  the call button starts the next call (on the iPhone once the notice is
  dismissed). Never for a missing OpenAI key, a line busy with another call,
  or a denied microphone (the desktop also: a window without WebRTC, a
  refused sign-in).
- **Going live and the clock:** "Connecting…" becomes live when the computer
  reports the call attached (any status but `connecting` and `ended`: `live`,
  `ending`, or one the client does not know) and the device's own data
  channel is open; the clock counts from that moment on the device's own
  clock. Accepted edge case: a call whose audio connects but whose data
  channel never opens stays on "Connecting…" (no clock, no captions) until
  Hang up or the idle hang-up; Hang up still works through the computer.
  There is no separate drop for it.
- **ICE gathering:** after 10 s the offer goes out with the candidates gathered
  so far; the call is not failed (a call whose audio never connects is dropped
  after 20 s).
- **Stale state:** a `GET /api/live/call` answer is applied only if no newer
  `live.call` frame arrived while it was in flight. A remote hang-up answered
  `404` re-reads the line.
- **Idle choices:** 1, 2, 3, 5, 10, 15, 30 or 60 minutes, one `PATCH` per choice.
- **Speaker choice (phones):** remembered per device.
- **Unknown status:** a status the client does not know counts as running (bar
  shown, Hang up allowed). **A `live.call` frame without a `call` key** is
  malformed and ignored, never read as "the line is free".
- **Voice notes:** cannot be played while this device is on a Live call; the
  play control is disabled and says "Voice notes can't play during a Live call."
  The phones also refuse where playback asks for the audio (the iPhone's
  `VoiceNoteCenter`, Android's `AudioFocusGate`, both for voice notes and
  voice previews), so a clip whose download finishes after the call started
  waits, ready, for the call to end, and a preview fetched before the call
  is refused with its reason ("Voice preview is off during a Live call." on
  Android).
- **Disclosure before the first call (phones):** a phone has no Live switch,
  so its first Live call is where Live is turned on. Before a phone's first
  Live call on that device, it shows the disclosure sentence (under **What a
  Live call sends to OpenAI**) once, with **Start call** and **Cancel**.
  Start call remembers it on that device (never shown there again) and starts
  the call; Cancel starts nothing and records nothing, so the next try shows
  it again, since the first call has not happened yet. The same on iPhone and
  Android.
- **Signed out:** when the app's own session becomes unauthorized (unpaired,
  token refused, signed out), it hangs up its own Live call at once and shows
  the `signed-out` words.
- **Words:** "computer", not "Mac", in Live call text, except where the text
  is truly Mac-only.
- **Accepted differences:** caption presentation and what backgrounding does
  stay per platform.

## End reasons

`LiveCallState.endReason` codes, the words every client shows for them
(English; the desktop's `src/locales/en.json` is the source) and whether the
call counts as dropped, which is what offers **Try again**:

| Reason code | Words | Dropped |
|---|---|---|
| `hung-up` | "Call ended." (the device that hung up shows nothing) | no |
| `idle` | "Call ended after a long silence." | no |
| `expired` | "Call ended: it reached OpenAI's time limit." | no |
| `content` | "OpenAI ended the call under its content rules." | no |
| `deleted` | "Call ended: the chat was deleted." | no |
| `shutdown` | "Call ended: OpenMausBot restarted." | no |
| `signed-out` | "Call ended: you were signed out." | no |
| `remote-hangup` | "Call dropped." | yes |
| `connection-lost` | "Call dropped." | yes |
| `sideband-lost` | "Call dropped." | yes |
| `error` | "Call dropped." | yes |
| unknown or missing | "Call ended." | no |

- When the ended call carries `error` (the harness's own words, for example
  "The call connection to OpenAI dropped." or "The call has ended because the
  phone that started it was unpaired from this computer."), clients show that
  text instead of the reason's words; the reason still decides dropped and
  Try again.
- Notices a client makes itself: the audio did not connect within 20 s →
  "Call dropped: the audio could not connect." (dropped); the device's own
  connection failed → "Call dropped." (dropped); the computer no longer
  reports a call this device was on, or OpenAI closed the call and no end
  frame followed → "Call ended." (not dropped; Android reads the reason
  OpenAI sends on its own channel the way the harness does, so there an
  OpenAI-side hang-up or a lost connection is a drop); this device's own
  session refused (see **Signed out** above) → the `signed-out` words; Android only: the app left the foreground → "Call ended.", another
  app took the audio → "Call ended: another app took the audio." (neither
  dropped). The iPhone ends on the background and on an audio interruption
  without a notice.

## What a Live call sends to OpenAI

Every place where Live is turned on or set up says, in these words:

> A Live call sends your voice to OpenAI, along with the chat's recent
> messages, the bot's answers and the details of any approval it asks for. The
> OpenAI key stays on your computer.

On the desktop: the Live choice in the call mode menu (and "Start a Live call
instead"), the key prompt, and the call's gear. On the phones: the Live
settings sheets, and once before each phone's first Live call (see
**Disclosure before the first call**). In detail, the harness sends OpenAI
the chat's last eight text messages at the start, the bot's answers on the
call's chat, approval card details (for example a command, up to 400
characters), question options, proposal titles, step names (never their
arguments), connect-an-app and credential card labels, and the bot's name,
title and description.

The **Read replies to typed messages** setting says what off means, on every
client:

> When this is off, messages you type during a call and the bot's answers to
> them are not sent to OpenAI.

With it off, two things about a typed message still reach OpenAI: what the
bot asks of the person while it works on it (an approval, question or
proposal prompt, and a connect-an-app or credential pointer, whichever
request raised them), and an answer that also covers a spoken line (lines
drained from the queue together get one answer, and a batch holding a
spoken line is answered aloud). The docs page says so.

## Errors

| Situation | Behaviour |
|---|---|
| No key on the computer | Desktop: key popover. Phones: "Set up Live calls on your computer first.", no Try again |
| Another call running | 409 with the active call; the client says who is on the line, no Try again. Every client hides its Live call button while another device holds the line, so this is only a race |
| Phone cannot reach the computer | Call button explains; no call starts |
| OpenAI refuses (key, quota, voice) | Clear message in the bar (existing `liveErrorMessage`) |
| Media or sideband drops | Bar shows the harness's words when it sent them, else "Call dropped." + **Try again**; bot work continues into the chat |
| Harness restarts mid-call | Call ends; clients show "Call ended: OpenMausBot restarted." when the harness says `shutdown`, else "Call ended."; no Try again |
| Phone unpaired, or sign-in revoked, mid-call | Call ends at once, reason `signed-out` with the harness's words; no Try again. A phone the computer no longer takes hangs up by itself at once (`session.close` on its own channel) and shows "Call ended: you were signed out." (the iPhone on its unpaired screen) |
| Bot turn fails / no text | Voice says the result is in the chat |
| Bot waits for an app to connect or a credential | Voice points to the chat once; never asks for a credential aloud |

## Security

- The OpenAI key never leaves the harness; phones cannot read or write it.
- Client data channels cannot send appends (allowlist `session.close` only).
- Approvals are decided on the harness with the strict spoken rule; the card
  stays tappable in every client.
- The companion gains exactly the four phone `/api/live/*` routes above, plus
  its own `POST /api/live/device-revoked` notice, which no phone can send.
- A phone's call ends when that phone is unpaired; a sign-in's call ends when
  that sign-in is revoked or signed out.
- Logs hold counters and codes only (existing summary line), never speech.

## Testing

- **Fake GPT-Live** (`server/testing/fake-openai-live.ts`): HTTP
  `POST /v1/live/sessions` + WebSocket `/v1/live/sessions/:id/attach` that plays
  scripted events and records commands; the harness reads its base URL from
  `OMB_OPENAI_LIVE_URL` (tests and fixtures only).
- Unit tests: controller (delegation → turn with `via: "call"`, relays,
  approvals yes/no/unclear, skill refusal, typed messages, idle hang-up,
  sideband loss, one call at a time), routes, companion allowlist, settings
  validation, desktop components, iOS `CompanionCore` (`swift test`), Android
  `:core`/`:app` unit tests.
- Isolated fixture (`scripts/control-omb.ts launch`) + fake GPT-Live for the
  end-to-end server path; the desktop UI in the browser pane; the iOS app in the
  simulator and the Android app in an emulator against a fixture.
- Real audio needs a microphone and a real key: each client is tested with
  real audio on a computer, an iPhone and an Android phone before its PR.

## Delivery

1. Harness controller + routes + desktop call bar (est. 2–3 days).
2. iPhone (est. 3–5 days).
3. Android (est. 3–5 days).

Estimates are rough, based on the size of the Live work so far. Upstream: open
an issue with this design before any PR; related open PRs: #1813 (Windows/Linux
calls), #739 (Android calls), #719 (iOS calls).

## Out of scope

Background calls (lock screen, CallKit / foreground service), handing a call
from desktop to phone, room (group) Live calls, camera or screen sharing,
choosing a microphone device.
