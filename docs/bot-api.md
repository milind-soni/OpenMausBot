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

## A key that acts as you

Off by default. For a server you run yourself, with bots doing work for you
unattended, the owner can mark a bot's key **Acts as me** on its Bot API card
(or `POST /api/bots/<botId>/bot-api/acts-as-owner` with `{"enabled": true}`).
A thread that key opens then runs as the owner's own work, like a routine they
wrote:

- at the bot's own access level, with its saved allowances (saved commands and
  tools answer as they would for the owner), unconfined, with the bot's tools;
- the message is the owner's request through the API, not information from a
  stranger, and the thread is not marked as outside work;
- the never-list (safety floor), the holds the bot's level puts on sends and
  other outbound actions, and the computer rules still apply: at Ask, an
  approval still waits for the owner in the app and the call answers
  `needs_approval`.

The risk, once: **anyone holding a marked key can make the bot do anything its
level allows.** The bot can also hand work to its teammates, which act at their
own access level, not this bot's. Treat it like the owner's own password.

Who and where:

- Only the owner marks a key: on a server one person uses (no members on its
  sign-in list and at most one admin, named by address), the app on that
  computer or the one admin's session; on a personal Cloud, its owner. If a
  second admin or a whole-domain admin is added later, the key stops acting as
  the owner at once.
  Anyone who may manage the key can take the mark off.
- Never on a team's Cloud or a shared or hosted workspace (one with members on
  its sign-in list), except a hosted workspace whose operator set the
  dedicated policy `OMB_SHARED_WORKSPACE_FULL_ACCESS=1`, where an admin may.
- Never for guest links or webhooks: only a Bot API key carries it.
- **New key** starts without the mark, and switching the API off forgets it.
  Marking and unmarking, including the mark a new key or switching the API off
  clears, are **Bot API** rows in Settings → Activity, a call
  taken this way shows "as you" among the card's calls, and every viewer of
  the card sees whether the key acts as the owner.

The mark is read on every call. A thread keeps what it was opened as: one
opened before the mark stays confined, and one opened with it can't be
continued through the API once the key no longer acts as the owner (the mark
taken off, a new key, or the server no longer allowing it), which answers `403`;
until then the person's own messages there run as in any thread of theirs, and
a person writing in it after that works confined, as in any API thread. Taking
the mark off doesn't stop a turn already running; it finishes as it started
(stop it from the thread in the app if needed).

A key without the mark keeps every rule above: confined, at Ask, no saved
allowances, no tools.

Each call is kept with the bot's API settings and shown on the card (count, last
call, recent calls) to those who can manage the key. Refused calls roll up into
one row per burst. Neither ever holds the key.

## Bot to bot across servers

A bot on one OpenMausBot server can hand work to a bot on another, over
Tailscale, a LAN or the internet, through that bot's Bot API. Its owner turns on
**Bot API** for the bot there and gives you the address and key from its card.

On your server, an admin saves it in Settings → You and your bots → **Teammates
on other servers** (Advanced): a name, the address (the whole Bot API address
from the card, or the server's address and the bot id) and the key.

- The address is https anywhere. Plain http only works for this computer or
  a private network (a LAN address, Tailscale's 100.x or `*.ts.net`,
  `*.local`), the same rule as the command line's `--url`
  ([headless-cli.md](headless-cli.md)); such a name must resolve to a private
  address. Link-local, cloud metadata and reserved addresses are
  refused, for typed addresses and for whatever a name resolves to, on every
  connection.
- The key stays on this server alone, in `remote-teammates.json` in the data
  folder (mode 600). It is never shown, listed, logged or put in a prompt, and
  it goes only to the saved address: redirects are not followed.
- **Test** checks the key without starting anything on the other server, and
  isn't counted as one of its calls. It says in words what is wrong: the server
  can't be reached, the key is wrong (make a new one there and save it again),
  the call was refused, the server is busy, or the address isn't a Bot API.
- **Remove** asks first, then forgets the key.

Your bots then see it in `list_bots` as `remote-<id>`, on another server, and
hand it work with `coordinate_bots`, by that id or its name (a bot on this
server with the same name wins):

- The brief goes once, with secrets taken out, marked as coming from a bot on
  another OpenMausBot server. The asking bot reads that thread at 30, 60 and then
  every 120 seconds, and waits as long as the other server's `retry-after` says
  (up to five minutes). If it keeps answering busy or can't be reached (more
  than five times), or gives any other error, the hand-off ends with the
  reason. Work that was sent is never sent again, also not after a restart:
  the thread it went to is kept in `remote-teammate-work.json` (mode 600) until
  the result is in, at most 30 days.
- More work in the same conversation goes on in the same thread there, so the
  other bot has the context; `thread: "new"` starts a new one. If the other
  server no longer has that thread, the work starts a new one.
- The reply resumes the asking bot as information from that bot, never as the
  person's approval. If the other bot stops for an approval, only its own owner
  can give it in their app, and the asking bot is told so.
- Rooms, `answers`, `post`, `ownThread`, files and a `consult` with
  `reply: "none"` don't reach another server; the call says why. Work started
  from outside (a webhook or a guest) can't use a teammate on another server.

On the other server it is an ordinary Bot API call: confined, at Ask and with no
tools (see [What a call may do](#what-a-call-may-do)), unless its owner marks
the key **Acts as me**. Its limits hold too: ten calls a minute for the key, and
no Bot API on a Cloud's Starter plan.

## Apps built on it

- [MausBot Notch](https://github.com/jgonzalez007/mausbot-notch) (community,
  macOS): a notch app that talks to your bots through the Bot API. **Option+Space**
  opens and closes the notch. It is maintained outside this repository.
