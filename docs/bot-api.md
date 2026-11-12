# Bot API

Each bot can take messages from outside: an app or a script sends it a message
with a key and gets its reply. It is off by default, per bot.

## Turning it on

In Bot settings (the gear in the bot's panel; Advanced: Access), **Bot API**: switch on **Let apps
talk to this bot**. The card shows the command to paste, with the key filled in.
The key is shown that once and kept hashed; when the card is opened again the
command shows `YOUR_KEY` in its place. **New key** replaces the key (apps using
the old one stop working); switching the card off forgets it. Only someone who
may edit the bot can switch it on, mint a key or switch it off; each of those
is a **Bot API** row in Settings → Activity.

## Plans

Bot API isn't part of a Cloud's Starter plan. There the card shows one line and
Upgrade; a new key is refused, and a key left from a higher plan answers `403`
with an upgrade message. An upgrade works at once, with the same key. Desktop and
self-hosted servers aren't affected.

## Calling it

```sh
curl -X POST "https://your.domain/hooks/api/bots/<botId>/messages" \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you do?"}'
```

The address lives under the webhook receiver's `/hooks` path, so wherever this
bot's webhooks are reachable (a Cloud's public name, a self-hosted edge that
forwards `/hooks/*` as [deploy/Caddyfile](../deploy/Caddyfile) does, or
`OMB_WEBHOOK_PUBLIC_URL`) the API is too; nothing new to open.

The JSON body takes:

- `message` (required, up to 20,000 characters): what to tell the bot.
- `thread` (optional): the `thread` an earlier answer returned, to go on in the
  same conversation. Only a thread the API opened can be continued this way.
- `wait` (optional, seconds, at most 300): how long to wait for the reply
  before answering `working`. The default is 50, under the 60 seconds of silence
  Fly's proxy is reported to allow; a longer wait is for a path you know keeps a
  quiet connection open.

Answers:

- `200 {"reply": "…", "thread": "<id>"}`: the bot's reply, text only.
- `202 {"thread": "<id>", "status": "working"}`: the bot is still at it. Read
  the thread later with `GET …/messages?thread=<id>` and the same key.
- `202 {"thread": "<id>", "status": "needs_approval"}`: the bot asked for an
  approval. Nobody outside can give it: the person opens the thread in the app
  and answers there; a later `GET` returns the reply.
- `400` bad body, `401` wrong key, `403` the API is off for this bot (or there is
  no such bot), `404` no such thread, `409` that thread is still working or the bot
  is at its limit of conversations at once, or 50 API calls are being answered,
  `413` body over 256 KB, `415` not JSON, `429` more than ten calls in a minute for
  this key, `502` the bot could not answer (the reason is on the card, not in the
  response).

## What a call may do

A call starts a normal thread the app shows, marked as sent through the Bot API.
Anything in that thread answers only from the bot's standing instructions, its
saved memory and the thread itself, whoever writes there next:

- It runs confined and in Ask, whatever the bot's own level, with none of its
  saved allowances. Nothing answers an approval for the caller.
- It has no shell, computer, browser, phone, connected apps, MCP servers or data
  tools, and none of OpenMausBot's own tools, so it can't start a thread, ask a
  teammate, make a routine or webhook, change the bot, write its memory or search
  other conversations.
- It works in the thread's own empty folder, and its words stay out of the person's
  other conversations. A call that fails shows on the card and in its thread, and
  reports to no Chief.

A key is like a password: whoever holds it can read what this bot can read, which
here means its instructions and memory, through its replies. A bot whose AI can't run
confined (Claude, Codex and the API-key AIs can) answers `403`. A key goes when the
teammate who made it leaves.

## Trusted QM delegation

An administrator may designate one enabled Bot API credential as a QM source by sending
`POST /api/bots/<botId>/bot-api` with `{"enabled":true,"trustedSource":"qm"}` through the
authenticated app API. Read the same route with `GET` and require
`{"enabled":true,"trustedSource":"qm"}` before changing QM traffic. Sending
`{"enabled":true,"trustedSource":null}` removes the designation without replacing the key.

A designated credential may send `x-qm-actor` with a
`shifu.qm.bot-delegation.v1` message. The receiver requires the header actor to match both
`requester.actorId` and `requester.scopeId === "personal:" + actor`. Missing or mismatched
context, a missing schema, or an unknown `shifu.qm.bot-delegation.*` version answers
`delegation_context_invalid`; a credential not designated for QM cannot
create a receiver turn. The first accepted call binds its thread to that actor, and a later
actor gets `403`.

The Bot API settings response keeps the accepted call's `actorId`, `scopeId`,
`authorizationKind`, `authority`, `boundary` and `doesNotExpandReceiverPermissions` for
read-back, and the same metadata is bound to the thread. The host, not the message body,
supplies those fields to the turn. A call without `x-qm-actor` stays on the legacy
raw-message path only when it has neither the delegation namespace nor the
requester/authorization/request shape, so the sender can roll back without letting a broken
delegation become ordinary data.

Each call is kept with the bot's API settings and shown on the card (count, last
call, recent calls) to those who can manage the key. Refused calls roll up into
one row per burst. Neither ever holds the key.
