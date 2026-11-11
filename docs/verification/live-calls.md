# Live calls: the call id and the call record

A Live call (OpenAI GPT-Live as the voice, the bot as the brain) leaves two
things in its chat. Every request spoken on it carries the call's id, and a call
that went live leaves one "call" row when it ends, which the desktop draws as a
record of what the bot did. This recipe checks both against the fake GPT-Live
(`server/testing/fake-openai-live.ts`) and the fake engine in a disposable
workspace. Nothing here touches audio, a real OpenAI key or a phone. The design
is "The call id and the call row" in
`docs/superpowers/specs/2026-09-25-live-call-bar-design.md`.

## Sub-features

- A request spoken on a call carries `callId` next to `via: "call"` on every
  path that delivers it: a new turn, a steer, the queue (also after a restart)
  and a late answer to a question. A typed line never carries one.
- A call that went live leaves exactly one `kind: "call"` row at the chat's
  active leaf, with the text `Call with <bot> · m:ss` and a `call` record. A
  call that never connected, or whose chat or bot was deleted during it, leaves
  none.
- With generated thread titles on, the bot's own engine names the call from its
  spoken requests and the title arrives as a patch of the row. With them off, or
  when nothing was asked, the row keeps `Call with <bot>`.
- The row is never bot context and never the next call's voice history.
- The desktop draws the row as a compact record: the title, the length, and the
  steps and approvals of the work the call's spoken requests started. It selects
  by call id and reads the whole transcript, so a record lists only its own
  call's work, also the steps that land after the row.

## Anyone may call, with their own OpenAI key

Live calls need no plan, from any client: the desktop app, a web browser, or a
phone through the companion. Each call uses the person's own OpenAI key: the
separate Live key when one is saved (`live.key`, `OMB_OPENAI_LIVE_KEY`, or the
desktop credential `openaiLiveKey`), else the OpenAI API key from Settings →
API keys (`openai.key`, `OMB_OPENAI_API_KEY`); `liveCallKey` in
`server/live-settings.ts`. `GET /api/config` reports `live.configured` and
`live.keySource` (`live` or `openai`), never the key. Without either key,
`POST /api/live/session` answers
`409 { "error": "Live calls use your own OpenAI key. Add it in Settings → API keys.", "needsKey": true }`
before anything reaches OpenAI, and the companion passes it to the phones
unchanged. The desktop and web app show that sentence under the call button
with **Open API keys**, which opens Settings at API keys.

```sh
pnpm exec vitest run server/live-settings.test.ts server/live-call-controller.test.ts server/routes/live.test.ts companion/test/proxy-response.test.ts
pnpm exec vitest run src/lib/live-call-media.test.ts src/components/CallView.live-mode.test.ts src/components/LiveKeyNeeded.test.ts src/components/LiveCallBar.render.test.ts
```

`server/live-call.e2e.test.ts` boots a server with no plan and no key: a
phone's start (through the companion or by its own client) and a desktop's
start answer 409 `needsKey`; after the OpenAI key is saved through
`PUT /api/config`, a phone's call starts with that key; a separate Live key
then wins; neither key appears in the config or the log.

## Azure OpenAI as the Live provider

With `live.provider: "azure"` (`OMB_LIVE_PROVIDER=azure`) a call creates its
GPT-Live session on the person's Azure OpenAI / Foundry resource:
`POST {endpoint}/openai/v1/live/sessions` with the deployment name
(`live.azureDeployment`, `OMB_AZURE_OPENAI_LIVE_DEPLOYMENT`, default
`gpt-live-1`) as `session.model`, and the sideband attaches to
`wss://{endpoint}/openai/v1/live/sessions/{id}/attach`. Both send the resource
key as `api-key`, never as a bearer token, and the session request refuses a
redirect, since `fetch` would carry `api-key` to another host. The key is only
`live.key`; the OpenAI API key is never used for Azure. `live.azureEndpoint`
(`OMB_AZURE_OPENAI_LIVE_ENDPOINT`) must be `https` on an Azure OpenAI host
(`azureOpenAiRoot` in `server/live-call.ts`), and `PATCH /api/live/settings`
refuses any other.

`live.key` goes only where it was saved for. Saving a key records `live.keyFor`:
`openai` or `azure:<host>` (`liveKeyTarget` in `server/live-config.ts`), and
`usableLiveKey` hands the key out only while calls go there. Switching the
Service or changing the endpoint's host, through `PATCH /api/live/settings` or
`PUT /api/config`, forgets the key and asks for it again, even after changing
back (`liveSavePatch`). A new path or deployment on the same host keeps it.
`keyFor` is never taken from a request. A key saved with Azure chosen and no
endpoint answers `400`. A key with no `keyFor` is from before Azure was offered,
so OpenAI's. In the environment, `OMB_OPENAI_LIVE_KEY` with `OMB_LIVE_PROVIDER=azure`
and `OMB_AZURE_OPENAI_LIVE_ENDPOINT` is the operator's own pairing, unless the
file already says where the key may go. So a key the app forgot stays forgotten
until one is saved again, including the desktop's copy in the OS store, and a
different key in the environment takes no pairing from the file.

Without the key, or with a missing or invalid endpoint,
`POST /api/live/session` answers `409` with `needsKey` and the Azure setup
sentence before anything leaves the harness. A call keeps the endpoint it
started with even if the settings change mid-call.

Azure refuses `session.client` (`400 Unknown parameter`), so an Azure call goes
without `LIVE_DATA_CHANNEL`: the caller's data channel keeps Azure's default
events instead of "may only hang up". This is read from the code and was not
checked against Azure: assume the caller could send session or item events and
receive events holding the bot's instructions. So an Azure call is limited to
an admin, or the owner of a single-owner server (`azureLiveCallRefusal` in
`server/live-access.ts`, asked by `LiveCallController.start`, the only place a
session is created):

| Caller | Azure call |
| --- | --- |
| Desktop app's window; the owner's phone through the companion | yes |
| Single-owner server: local request, or a paired admin device | yes |
| My Cloud: the owner's session | yes |
| Team Cloud: Super admin, Admin | yes |
| Shared company workspace: admin | yes |
| Self-hosted with a sign-in list: admin session | yes |
| Team Cloud User, on the app or their phone; a workspace non-admin; a chat-only device | no, plain sentence |
| A local request where others use the server (a bot's shell): Team Cloud, shared workspace, sign-in list, a chat-only device or code | no |
| A sign-in that only moves a bot in | no |
| A published or inline page, with or without an admin's cookie | no |

The refused answer is `403 { "error": "Live calls here go through Azure OpenAI, so only an admin or the owner of this server can start one. Ask an admin if you need a call." }`,
with no `needsKey`. Nothing reaches Azure or OpenAI: a refused call never falls
back to another provider. `GET /api/config` and the stream tell a session
without the admin scope `live.provider`, never `azureEndpoint` or
`azureDeployment`. `server/live-access.test.ts` runs each caller above through
the sign-in gate and the limit. `server/live-azure-access.e2e.test.ts` does it on
the full server with a made-up key and its `fetch` stubbed.
`server/hosted-access.test.ts` does it for a shared workspace, with no key saved,
so a caller who gets through stops at the setup prompt.

## Fish Audio Live 3 as the Live provider

With `live.provider: "fish"` (`OMB_LIVE_PROVIDER=fish`) a call starts the
person's published Fish Audio agent (`live.fishAgentId`, `OMB_FISH_LIVE_AGENT_ID`,
letters, digits, `-` and `_`): `POST https://api.fish.audio/v1/agent/sessions`
with `{ agent_id, overrides: { system_prompt } }` and the key as a bearer token,
redirects refused. Fish answers with a LiveKit token, which goes to the client
as `transport: { type: "fish", session, relayToken }`; the client joins with
`@fishaudio/agent-client` 1.x, which holds the microphone and the agent's
audio. The agent's voice is its own; the Voice setting is hidden. Hanging up
also calls `POST /v1/agent/sessions/{id}/end`. `OMB_FISH_LIVE_URL` points the
harness at a fake Fish for tests and is honoured only as `http://127.0.0.1:<port>`;
anything else falls back to Fish's own host.

The key is only `live.key`, saved with `keyFor: "fish"`; an OpenAI or Azure key
is never sent to Fish, and switching the Service forgets the key as for Azure.
In the environment, `OMB_OPENAI_LIVE_KEY` with `OMB_LIVE_PROVIDER=fish` and
`OMB_FISH_LIVE_AGENT_ID` is the operator's pairing. Without the key or a valid
agent id, `POST /api/live/session` answers `409` with `needsKey` and the Fish
setup sentence.

Fish has no server sideband. The client reports what it hears (final user
transcripts, the agent's speaking spans, the `delegate` tool call, the end) to
`POST /api/live/relay` with the call's random relay token, and long-polls the
same route for the bot's answers. `FishRelay` (`server/live-fish.ts`) turns the
reports into the GPT-Live sideband events `LiveCallController` already reads
and the controller's appends into commands the client hands the agent: the
answer to a pending `delegate` call as its tool result, anything later as a
user message prefixed `[OpenMausBot]`. Every report is a strict, bounded zod
shape; a wrong token or session answers `404`; the route needs the admin scope.
The `delegate` tool's arguments are ignored: the request is what the client
heard, as on GPT-Live.

Because the harness hears a Fish call only through its client's reports, a
Fish call is limited exactly like Azure (`fishLiveCallRefusal`), with the words
`Live calls here go through Fish Audio, so only an admin or the owner of this
server can start one.` The phone apps do not carry the Fish SDK yet, so a call
from iOS or Android answers `400`. The client must report `connected` within
`FISH_ATTACH_TIMEOUT_MS` (25 s, to allow a first microphone prompt).

To activate, the person needs:

- A Fish Audio API key with Agent credit (about $0.07 per minute of call).
- An agent on the `live3` engine with a voice, `overrides_allowed` including
  `system_prompt`, and a client tool named `delegate` with `expects_response`
  and a timeout of 15–30 s attached through `tool_ids`; the agent published.
- English as the call language.

Checked with fixtures only: `server/live-fish.test.ts` (session request,
errors, relay), `server/live-call-controller.test.ts` "with Fish Audio chosen"
(a real `FishRelay` as the sideband: heard, delegated, the bot's answer back as
the delegate result, End and Fish's own end), `server/routes/live.test.ts`
(relay route), `server/live-settings.test.ts`, `server/live-access.test.ts`,
`src/lib/live-call-fish.test.ts` (client relay with a fake SDK session) and
`src/components/keys/KeysPage.dom.test.ts`. No call has been placed against
Fish Audio's live service.

## User path

Start a Live call from the call button's menu, say something the bot must act
on, and hang up. The chat keeps what you said (labelled "via call"), the bot's
steps and answer, and below them one small record of the call.

## Drive and evidence

The server paths, including steer, queue, restart and late answers, need a
scripted voice, so their recipe is the end-to-end test:

```sh
pnpm exec vitest run server/live-call.e2e.test.ts server/chat-followups-restart.test.ts
pnpm exec vitest run server/live-call-record.test.ts server/live-call-controller.test.ts server/steer-queue.test.ts server/thread-title.test.ts server/delta-context.test.ts server/live-call.test.ts server/store.test.ts
pnpm exec vitest run src/lib/call-record.test.ts src/lib/live-activity.test.ts src/lib/activity-runs.test.ts src/components/CallRecordRow.test.ts src/components/ChatView.via-call.test.ts src/components/ChatView.rows.test.ts
pnpm typecheck
pnpm i18n:check
```

`server/live-call.e2e.test.ts` boots the real harness in a disposable home with
fake engines and the fake GPT-Live, starts calls the way a client does
(`POST /api/live/session`), plays the voice's side over the sideband (some
`session.input_transcript.delta` events, then a `session.delegation.created`)
and hangs up (`POST /api/live/call/end`). It checks the call id on a new turn,
a steered line, a queued line (also one lifted from the queue by Steer) and a
late answer; one row per call that went live, and none for a call that never
did or whose bot was deleted; the title patch with generated titles on, and
none while they are off; the row's absence from the next call's startup
history; and that the row and the server log hold none of the spoken words and
neither the log nor the event stream holds the key.
`server/chat-followups-restart.test.ts` kills a fixture server in the middle of
a dispatch and checks the recovered lines: one spoken on a call comes back with
its call id, a typed one that carried a stray call id comes back without it.

By hand, a call with no spoken request shows the row and the record. The
standalone fake cannot be scripted from the shell, so nothing is asked on it:

```sh
# terminal 1: the fake GPT-Live prints its base URL
node --experimental-strip-types server/testing/fake-openai-live.ts
# terminal 2: the renderer fixture, pointed at it (the key only ever reaches
# the fake)
OMB_OPENAI_LIVE_URL=http://127.0.0.1:FAKE_PORT OMB_OPENAI_LIVE_KEY=sk-fake \
  node --experimental-strip-types scripts/control-omb.ts ui launch
# terminal 3, with the url, botId and ui handle it prints
pnpm control:omb messages --bot BOT_ID --url http://127.0.0.1:PORT
curl -s -X POST http://127.0.0.1:PORT/api/live/session -H 'content-type: application/json' \
  -d '{"botId":"BOT_ID","sdp":"v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n","client":"desktop"}'
curl -s http://127.0.0.1:PORT/api/live/call
curl -s -X POST http://127.0.0.1:PORT/api/live/call/end -H 'content-type: application/json' \
  -d '{"callId":"CALL_ID"}'
pnpm control:omb ui wait-settle --ui /tmp/openmausbot-verify-data-XXXXXX/ui.json --timeout 60
pnpm control:omb ui snapshot --ui /tmp/openmausbot-verify-data-XXXXXX/ui.json
curl -s "http://127.0.0.1:PORT/api/threads/THREAD_ID/messages?limit=20"
```

`taskId` in the first command's JSON is THREAD_ID. Repeat the `curl` on
`/api/live/call` until `status` is `live`. Expected: the start answers `201` with
`status: "connecting"`; the hang-up answers `status: "ended"` with
`endReason: "hung-up"`; the last command lists one `kind: "call"` row whose
`call` holds `callId`, `botId`, `client`, `startedAt`, `endedAt`, `seconds: 42`
(the fake reports 42 s of usage, whatever the wall clock) and `endReason`, and
no `title`, because nothing was asked; and the snapshot's transcript has
`group "Live call: Call with Pepper, 0:42"`. Stop the fixture with Ctrl-C.

## Gotchas

- `pnpm control:omb messages` projects a fixed set of fields: it shows the
  row's `kind` and its text, but not `via`, `callId` or `call`. Read the last
  command above for those.
- Only generated thread titles name a call (`features.llmThreadTitles`; see
  [Chat UI](chat-ui.md) for `ui flag --set`), and only from what was asked on
  it: a call where nothing was asked is never titled.
- The fixture's fake engine answers a title one-shot from
  `FAKE_CLAUDE_TEXT_ROUTES`, which crosses into the fixture like the other
  `FAKE_CLAUDE_*` variables. Without a route it answers "fake generated text".
- A call that must not go live needs the sideband refused with a 404
  (`refuseNextAttach(404)` in the e2e). Node's WebSocket retries a refused 401
  upgrade and the retry is accepted.
- Only one call runs at a time: while one is open, another start answers `409`.
  End a call a failed run left open, or restart the fixture.
- `OMB_OPENAI_LIVE_URL` crosses into a fixture only when it is a loopback
  `http://127.0.0.1:PORT`, and `OMB_OPENAI_LIVE_KEY` only with it.
- Without `OMB_OPENAI_LIVE_KEY` the fixture answers every start with `409`
  `needsKey`, and the desktop shows "Live calls use your own OpenAI key" with
  **Open API keys** under the call button. That is the way to see it by hand.

## Boundaries

- No audio, WebRTC, real OpenAI key or bill. The scripted voice sends what the
  e2e sends; GPT-Live may time its transcripts and delegations differently.
  Each client is still tested with real audio and a real key before its PR, as
  the call bar's design says.
- The title one-shot is the fake engine's scripted answer. This proves the gate,
  the excerpt (spoken requests only) and the patch, not the quality of a title.
- The renderer here is the web renderer in headless Chrome, not the packaged
  Electron shell. The e2e is POSIX-only (its fakes are shebang scripts), so
  Windows is not exercised.
- Phone builds read the same wire fields and, when they do not know the kind,
  the row's text; their own record is verified in SupaMaus/mausbot-mobile.
- Approval lines in a record ("Allowed", "Denied", "Expired", "by voice"), a
  hang-up while a turn is still working, a step that never reported how it went
  (running only while the chat works) and a call that began before the loaded
  page (the record says some of it may be in earlier messages) are covered by
  `src/lib/call-record.test.ts`, `src/components/CallRecordRow.test.ts` and
  `src/components/ChatView.via-call.test.ts`, and a spoken yes by the e2e's
  approval test. The fixture run below does not draw them.

## Last exercised

2026-10-08, isolated macOS fixture from `ui launch` on `feat/live-call-record`
at 0d761f09: harness on port 22340, the fake GPT-Live on a loopback port, the
fake engine, and headless Chrome for Testing 153 through agent-browser 0.37.0.
Generated titles were switched on with `ui flag --set
features.llmThreadTitles=true` after the first call, and a
`FAKE_CLAUDE_TEXT_ROUTES` entry answered the title prompt. The voice's side of
the calls that asked something was played by a throwaway script, not kept in the
repository, that called `startFakeOpenAiLive` and `emit` the way the e2e does.

- Call A, titles off: the spoken request "what is six times seven" landed as a
  user line with `via: "call"` and a `callId` equal to the call's id, the bot ran
  a Bash step and answered, and the voice was told the answer. After the hang-up
  (`endReason: "hung-up"`) there was one row, `Call with Pepper · 0:42`, with
  `seconds: 42` (the fake's usage, though start to end took 2.6 s on the wall
  clock), no title, and no patch within 12 s.
- Call B, titles on: the same, plus a message typed while the call was up. The
  typed line carried no `via` and no `callId`. The row was written untitled, and
  `Times table question` arrived as a `message.patch` of the same row, whose
  `text` stayed `Call with Pepper · 0:42`.
- Call C, the fake refused the sideband upgrade with a 404: the call ended
  `sideband-lost` with `seconds=0` in the log and left no row.
- Call D, live with nothing asked and titles on: one row, no title.
- Renderer: three `region "Live call: …"` records and none for call C. A read
  "Call with Pepper, 0:42" with one line, "Running a command (Done)". B read
  "Times table question, 0:42" with one line, although the typed turn ran its own
  Bash step during the call; that turn's chip and reply sit above the record,
  unlisted. D read "Call with Pepper, 0:42" with no lines. The sidebar row kept
  previewing the bot's last reply, not the record.
- The fixture's log had a `call started` and a `call ended` line for each of the
  four calls, `text=(spoken)` for the spoken turns, and neither the spoken words
  nor the key anywhere.
- Ctrl-C stopped the fixture and removed its data directory; no fixture, preview
  or driver process was left. The log stays at its printed path.
- `pnpm exec vitest run server/live-call.e2e.test.ts server/chat-followups-restart.test.ts`:
  2 files, 18 tests passed in 258 s with the machine's load average above 150.
  The 13 unit files in the second and third commands above: 404 passed.
- Since that run the final fix wave changed what the renderer draws: the record
  is a `group`, so the snapshot lists `group "Live call: …"` where this run saw
  `region`; the words a screen reader hears after a step are the tool chip's own
  ("Running a command (Completed)", where this run saw "(Done)"); a long line
  truncates inside the pill; and a step the harness never settled reads as
  running only while the chat works, and as a dash after.

## Re-exercised after the final fix wave

2026-10-09, the same isolated fixture (`ui launch`, the fake GPT-Live driven by
the same throwaway script, headless Chrome for Testing 153) on
`feat/live-call-record` at 40099d93, whose production code is d81c3b05's: one
call, titles off, one spoken request ("what is six times seven"), hung up.

- The row was written as before (`Call with Pepper · 0:42`, `seconds: 42`,
  `hung-up`, the spoken line carrying the call's `callId`). `ui snapshot`
  listed `group "Live call: Call with Pepper, 0:42"` with `StaticText "Call with
  Pepper"`, `StaticText "Running a command"` and `StaticText "(Completed)"`, and
  no `region`. The screenshot showed the pill centred under the reply, the
  waveform glyph, the title, `· 0:42` and one line with a check.
- Width, measured in the page: with a line of about 300 characters the pill
  stayed at its 32 rem limit, the list inside it at 478 px, and the line
  truncated; with `max-w-full` taken off the list (the old markup) the list
  measured 1816 px and ran from -108 px to 1708 px, past both sides of the
  pill.
- `text-ink-tertiary`, the dash's colour, resolved to a real colour
  (`rgba(252, 252, 252, 0.565)`, against `0.6` for the pill's own text). The
  console held four debug and two info entries and no error or warning.
- Not driven here, because the fake engine settles every tool call it makes and
  a page of more than 200 messages is out of reach of a hand run: a step with no
  outcome (the dash), "Expired", and the partial-record hint. The component
  tests pin them (`src/components/CallRecordRow.test.ts`,
  `src/components/ChatView.via-call.test.ts`).
- SIGINT to the exact `ui launch` pid removed its data directory and the driver
  was stopped; `ps` showed no fixture, preview, driver or browser process left.
