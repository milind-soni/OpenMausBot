# Telegram, one bot of the person's own per MausBot bot

A bot's settings take a Telegram bot token from BotFather. Once Telegram
accepts it, the server reads that bot's messages by long polling, so no public
address is needed, and the person links their own chat by opening a
`https://t.me/<bot>?start=<code>` link. Only linked chats are heard; each has
one thread on the bot, and every finished turn in it goes back to Telegram as
plain text. The token lives sealed in `telegram.json` next to a `telegram-key`
file, never in `bots.json`, and no route returns it. The channel is off on a
Team Cloud.

Code: the chat-app core in `server/channels/core.ts`, Telegram's Bot API and
poller in `server/channels/telegram.ts`, the routes and per-bot readers in
`server/channels/telegram-host.ts`, the card in
`src/components/bot-settings/TelegramCard.tsx`, and a loopback stand-in for the
Bot API in `server/testing/fake-telegram.ts`.

## Tests

```sh
pnpm vitest run server/channels src/components/bot-settings/TelegramCard.dom.test.ts
```

`server/channels/core.test.ts` covers linking (a live code, expiry, the try
cap, the chat cap, a stranger told once, groups ignored), one thread per chat
and `/new`, redelivery dropped, ordered replies behind a cursor, the approval
note, and that a chat linked to one bot is a stranger to another.
`server/channels/telegram.test.ts` covers the Bot API client, update parsing,
the loopback-only `OMB_TELEGRAM_API_BASE`, and the poller's offset, back-off
and pause. `server/channels/telegram-host.test.ts` covers the routes' trust
(owner or admin, never service-trust loopback), the Team Cloud refusal, and
readers that stop when a bot is deleted and come back after a restart.
`server/channels/telegram.e2e.test.ts` runs the whole path on a real server
with the scripted engine: a token per bot, `/start <code>`, a message answered
on Telegram, a second bot's chat kept apart, Disconnect.

## Isolated browser verification

Use an installed Playwright module and Chromium, as for [Whop](whop.md):

```sh
OMB_VERIFY_PLAYWRIGHT=/path/to/playwright/index.mjs node --experimental-strip-types scripts/verify-telegram.ts
```

It launches a disposable fake-engine workspace with `OMB_TELEGRAM_API_BASE`
pointed at the loopback stand-in (the launcher forwards only a
`http://127.0.0.1:PORT` value), makes a bot, and drives the real card through
`scripts/testing/telegram-preview.tsx`. It checks:

- Connect stays off until a token is typed; a refused token shows Telegram's
  reason and leaves the bot disconnected.
- A good token shows **Connected as @scout_bot**; neither `telegram.json` nor
  `GET /api/bots/<id>/telegram` carries the token.
- **Link your Telegram** shows the `t.me` link with the code and waits; a
  `/start <code>` from a chat links it, the card shows **Linked: Ada**, and the
  chat is told it is connected.
- A message from the linked chat gets the bot's reply on Telegram, in a thread
  titled Telegram.
- **Disconnect** forgets the token and returns to the start.

Screenshots go to `OMB_UI_EVIDENCE_DIR` (default `/tmp/omb-telegram-evidence`).
No real Telegram bot, token or chat is used, so Telegram's own rate limits and
its refusal of a second poller on the same token are not exercised here.
