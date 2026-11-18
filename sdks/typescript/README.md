# mausbot

Talk to a MausBot bot from your own code, through its Bot API. No dependencies; Node 18+, Bun, Deno. Server-side only: the key acts as you.

```sh
npm install mausbot
```

```ts
import { Bot } from "mausbot";

const bot = new Bot({
  endpoint: process.env.MAUSBOT_BOT_URL, // the address on the bot's Bot API card
  key: process.env.MAUSBOT_BOT_KEY,
});

const answer = await bot.ask("What's on my calendar tomorrow?");
// { status: "replied", reply, thread } | { status: "needs_approval", thread }
await bot.ask("Move the 3pm to Friday", { thread: answer.thread });

const sent = await bot.send("Start the weekly report", { wait: 0 }); // one POST, the server's answer as is
const now = await bot.thread(sent.thread);                         // one GET
const done = await bot.wait(sent.thread, { timeout: 600 });         // keeps reading until it is not "working"
```

Paste the card's address as it is. With no options, `Bot` reads `MAUSBOT_BOT_URL` and `MAUSBOT_BOT_KEY`. You can also pass `baseUrl` and `botId`.

`ask` returns `needs_approval` as a result: a person answers it in the app, and you can `wait` again later. If the thread is still busy, `ask` waits for it, then sends once; if that thread is waiting for an approval it throws `NotSentError` and sends nothing.

## Errors

All errors extend `MausBotError`. HTTP errors extend `APIStatusError` (`status`, `body`, the server's `error` text as the message): `BadRequestError` (400, 413, 415), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429, with `retryAfter` in seconds when sent), `ServerError` (5xx), and `ServerTooOldError` (this MausBot server has no `/v1` address; update MausBot). Others: `APIConnectionError`, `WaitTimeoutError`, `JobFailedError` and `NotSentError`, each carrying the `thread` id where there is one. The key is never put in an error.

## Retries

Only `GET`, on a network error or a 5xx: `maxRetries` times (default 2), waiting `retryDelay` seconds (default 0.5) and doubling. A `POST` is never retried, since that could start a second turn. `wait` and `ask` give up after `timeout` seconds (default 600) and poll every `pollInterval` seconds (default 2, growing to 10).
