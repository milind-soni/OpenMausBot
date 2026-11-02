# Bot API

Each bot can take messages from outside: an app or a script sends it a message
with a key and gets its reply. It is off by default, per bot.

## Turning it on

In the bot's panel (or Bot settings → Access), **Bot API**: switch on **Let apps
talk to this bot**. The card shows the command to paste, with the key filled in.
The key is shown that once and kept hashed; when the card is opened again the
command shows `YOUR_KEY` in its place. **New key** replaces the key (apps using
the old one stop working); switching the card off forgets it. Only someone who
may edit the bot can switch it on, mint a key or switch it off; on a Team Cloud
each of those is a **Bot API** row in Settings → Activity.

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
  before answering `working`. The default is the maximum.

Answers:

- `200 {"reply": "…", "thread": "<id>"}`: the bot's reply, text only.
- `202 {"thread": "<id>", "status": "working"}`: the bot is still at it. Read
  the thread later with `GET …/messages?thread=<id>` and the same key.
- `202 {"thread": "<id>", "status": "needs_approval"}`: the bot asked for an
  approval. Nobody outside can give it: the person opens the thread in the app
  and answers there; a later `GET` returns the reply.
- `400` bad body, `401` wrong key, `403` the API is off for this bot, `404` no
  such thread, `409` the thread is still working or fifty calls are in flight,
  `413` body over 256 KB, `429` more than ten calls in a minute for this key.

## What a call may do

A call starts a normal thread the app shows, marked as sent through the Bot API.
The turn is outside work, like a webhook's: it never acts for the person, never
uses a Mac or PC lent to a Cloud, and gets the message inside an untrusted-data
block. Every approval the bot would ask for waits for the person; none is
granted for the caller. Each call is recorded with the bot's API settings
(count, last call, recent calls) and never carries the key.
