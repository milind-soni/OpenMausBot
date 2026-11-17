# Waits: tell me when, with no AI while waiting

A wait is a condition a bot sets up once ("tell me when report.txt is there"); plain server
code checks it on a timer, and no model runs until it fires. See the
[design](../superpowers/specs/2026-10-27-waits-design.md).

## Automated checks

```sh
pnpm exec vitest run server/wait-probes.test.ts server/waits.test.ts server/wait-host.test.ts server/routes/waits.test.ts server/drivers/agents-wait-tools.test.ts server/bot-moves.test.ts server/move-freeze.test.ts server/waits.e2e.test.ts src/components/ApprovalCard.test.ts
```

## In a fixture

The fake engine calls `wait_until` on every turn it runs, including the follow-up.
A follow-up proved by its live turn generation, originating wait run and fired notice
can create its next wait in the same bot's direct chat. Continuation authorization is
checked again after the initial probe, before returning immediate follow-up instructions
or persisting a wait. The multi-stage e2e test exercises two completions and
registration of the next stage. Scheduled routines and unrelated outside events
retain their existing refusal. A condition already true returns immediately and
directs the bot to carry out its follow-up in that turn.

```sh
W=$(mktemp -d)
printf '[{"server":"agents","name":"wait_until","input":{"label":"the report","kind":"file_exists","path":"%s/report.txt","follow_up":"Say the report is ready."}}]' "$W" > "$W/calls.json"
FAKE_CLAUDE_TOOL_CALLS_FILE="$W/calls.json" node --experimental-strip-types scripts/control-omb.ts launch
```

Second terminal (same `W`; `DATA` is the `dataDir` the launcher printed):

```sh
pnpm control:omb new-bot --name Pepper --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "Tell me when report.txt is there, then say so" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 30 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 12 --url http://127.0.0.1:PORT
touch "$W/report.txt"; sleep 25
pnpm control:omb wait --bot BOT_ID --timeout 60 --url http://127.0.0.1:PORT
pnpm control:omb messages --bot BOT_ID --limit 12 --url http://127.0.0.1:PORT
curl -s http://127.0.0.1:PORT/api/notifications
cat "$DATA/waits.json"
sleep 10; pnpm control:omb messages --bot BOT_ID --limit 12 --url http://127.0.0.1:PORT
```

Expected:

- After the first `messages`: a `wait_until` tool row with `"ok": true`, and one
  `options` card titled `Waiting: the report` with the subtitle
  `Then Pepper will: Say the report is ready.`
- After the `touch`: exactly one bot line `the report: done. <W>/report.txt is there now.`
  carrying `"wait": { "id": "...", "status": "fired" }`, then a user line
  `[Wait finished: the report] Say the report is ready.`, then that turn's `wait_until`
  row with `"ok": true` (the condition already holds, so the result asks it to
  carry out `follow_up` now), and the fake engine's reply.
- Still one `options` card because the condition already holds.
- `waits.json` holds `"waits": []`.
- One notification with `"kind": "wait"` and `"title": "Pepper's wait is over"`.
- The last `messages` still shows one fired line.

**What it does not prove:** the desktop card's Cancel button and its ended lines (the
card test and the e2e undo call cover them), phones, a Cloud home, a real page on the
internet, and what a real model does with the follow-up (the fake engine replies
`hello from fake claude` regardless of the prompt).

**Cleanup:** Ctrl-C the launcher; `rm -r "$W"`.

## Last exercised

2026-11-16, macOS arm64, Node 26.5.0. Twelve targeted Vitest files passed with
505 tests, including successive build, test and package waits in one direct chat,
originating-run and live-generation authorization, and rejection when continuation
authorization changes during a URL probe with either a matching or pending condition.
The packaged server passed its smoke checks and all four wait and handed-wait
e2e tests against disposable fixture data. The route tests also cover immediate
follow-up when the requested condition already holds.

## Earlier fixture transcript

2026-10-28, Node 24, branch `feat/bot-waits` at `4fc4ef0bb`, fixture log
`/var/folders/7b/15jj691d4tj_7vq99cqvwgbr0000gn/T/openmausbot-verification-evidence/server-1793162265419-23568.log`.
The lines below record the original continuation refusal. They are abridged to
selected message fields, and `<W>` stands for the temp dir.

`wait_until` answer in the person's turn:

```text
Waiting for the report (wait id 8fef1e72-d37f-41f2-bb8d-a8b015ebe237): plain checks, no AI, until 2026-10-29T04:38:07.391Z. When it happens a message lands in this chat, and you will then do what you wrote in follow_up. Tell the person in one sentence; do not keep checking yourself.
```

The card, read from `/api/threads/THREAD_ID/messages` after it fired:

```json
{"title": "Waiting: the report", "subtitle": "Then Pepper will: Say the report is ready.", "answered": "allow", "dismissed": true, "waitRequest": {"waitId": "8fef1e72-d37f-41f2-bb8d-a8b015ebe237", "label": "the report", "followUp": "Say the report is ready.", "settled": "fired"}}
```

From the fired line on:

```json
{"role": "bot", "kind": "text", "text": "the report: done. <W>/report.txt is there now.", "wait": {"id": "8fef1e72-d37f-41f2-bb8d-a8b015ebe237", "status": "fired"}}
{"role": "user", "kind": "text", "text": "[Wait finished: the report] Say the report is ready."}
{"role": "bot", "kind": "activity", "tool": {"name": "wait_until", "ok": false, "spoken": "running wait_until"}}
{"role": "bot", "kind": "text", "text": "hello from fake claude"}
```

The refused call's result, from the chat's event log:

```text
Only the person can set up or stop a wait, in their own chat with you; work handed to you by a bot, a routine or an outside event cannot.
```

`waits.json` after:

```json
{"version": 1, "waits": []}
```

Wait notification (the two turns also left their own `"kind": "done"` notifications):

```json
{"kind": "wait", "botName": "Pepper", "title": "Pepper's wait is over", "body": "the report: done. <W>/report.txt is there now.", "read": false}
```
