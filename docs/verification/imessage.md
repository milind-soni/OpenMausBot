# iMessage, one Sendblue line of the person's own per MausBot bot

A bot's settings take a Sendblue API key ID and secret and the Sendblue number
the bot will use. Once Sendblue accepts them (`GET https://api.sendblue.com/api/v2/lines/state` lists
the number on the account), the server asks Sendblue for new inbound messages
every four seconds (`GET https://api.sendblue.com/api/v2/messages` with `is_outbound=false`, oldest
first, from a saved cursor), so no public address or webhook is needed. The
person links their own iPhone by texting `link <code>` to that number. Only
linked numbers are heard, only one-to-one messages (a `group_id` is ignored),
and a number that is not linked gets no answer at all. Each linked number has
one thread on the bot, and every finished turn in it goes back as plain text
from the bot's number (`POST https://api.sendblue.com/api/send-message`). The key and secret live
sealed in `imessage.json` next to an `imessage-key` file, never in `bots.json`,
and no route returns them. The channel is off on a Team Cloud, and one number
belongs to one bot.

Sendblue's free plan shares one number and, per its docs, only lets you message
contacts you verified there (add the contact, then it texts the line once).
Linking by text is that first text. Sendblue's docs do not say in as many
words that a free line may reply once a verified contact has texted first, and
a dedicated line is documented to reply to anyone who texted it first, so a
free-plan reply is the part this recipe cannot prove without a real account.

Code: the chat-app core in `server/channels/core.ts`, the shared reader in
`server/channels/poller.ts`, Sendblue's API in `server/channels/sendblue.ts`,
the routes and per-bot readers in `server/channels/sendblue-host.ts`, the card
in `src/components/bot-settings/IMessageCard.tsx`, and a loopback stand-in for
the API in `server/testing/fake-sendblue.ts`.

## Tests

```sh
pnpm vitest run server/channels src/components/bot-settings/IMessageCard.dom.test.ts
```

`server/channels/sendblue.test.ts` covers the API client (key and number check,
the inbound list's filters and cursor, groups and our own messages dropped, the
send body, Sendblue's refusals, and that no error carries a key), the typed
number and key checks, the loopback-only `OMB_SENDBLUE_API_BASE` and the `sms:`
link. `server/channels/sendblue-host.test.ts` covers the routes' trust (owner or
admin, never service-trust loopback), the Team Cloud refusal, one number per
bot, a message heard once however often Sendblue lists it, a stranger and a
group never heard, two bots kept apart, the start point and the cursor across a
restart, back-off and recovery, and readers that stop on deletion and
Disconnect. `server/channels/core.test.ts` covers the transport's own link
command and a transport with no note for strangers. `server/channels/poller.test.ts`
covers the shared reader's interval, back-off and pause.
`server/channels/sendblue.e2e.test.ts` runs the whole path on a real server with
the scripted engine: a key per bot, `link <code>`, "hello" answered from the
bot's number, an unlinked number, a group and the other bot's line never heard,
Disconnect.

## Isolated browser verification

Use an installed Playwright module and Chromium, as for [Whop](whop.md):

```sh
OMB_VERIFY_PLAYWRIGHT=/path/to/playwright/index.mjs node --experimental-strip-types scripts/verify-imessage.ts
```

It launches a disposable fake-engine workspace with `OMB_SENDBLUE_API_BASE`
pointed at the loopback stand-in (the launcher forwards only a
`http://127.0.0.1:PORT` value), makes a bot, and drives the real card through
`scripts/testing/imessage-preview.tsx`. It checks:

- Connect stays off until a key, secret and number are typed; a refused secret
  shows Sendblue's reason and leaves the bot disconnected.
- A good account shows **Connected to +14155550100**, with the number typed as
  `+1 (415) 555-0100` turned into E.164; neither `imessage.json` nor
  `GET /api/bots/<id>/imessage` carries the key or the secret.
- **Link your iPhone** shows `link <code>` and an `sms:` link with the code in
  it, and waits; that text from a number links it, the card shows the number,
  and the number is told it is connected.
- A message from the linked number gets the bot's reply from the bot's number,
  in a thread titled iMessage.
- **Disconnect** forgets the key and returns to the start.

Screenshots go to `OMB_UI_EVIDENCE_DIR` (default `/tmp/omb-imessage-evidence`).
No real Sendblue account, key, number or iPhone is used, so Sendblue's own rate
limits, its response to a free line replying, SMS fallback and delivery are not
exercised here.
