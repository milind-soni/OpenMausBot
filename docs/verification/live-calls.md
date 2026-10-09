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
# terminal 2: the renderer fixture, pointed at it (the key only ever reaches the fake)
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
- Since that run the final fix wave changed what the renderer draws. These are
  pinned by `src/components/CallRecordRow.test.ts` and were not driven in the
  fixture again: the record is a `group`, so the snapshot lists
  `group "Live call: …"` where this run saw `region`; the words a screen reader
  hears after a step are the tool chip's own ("Running a command (Completed)",
  where this run saw "(Done)"); and a step the harness never settled reads as
  running only while the chat works, and as a dash after.
