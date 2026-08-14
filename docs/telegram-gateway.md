# Telegram gateway — chat with your bots from your phone

OpenMausBot keeps the messaging-app shape — the Telegram gateway extends it off the Mac. It is an **optional standalone process** that rides the harness HTTP+SSE contract: nothing in the app or server changes, the gateway is just another client.

```
Telegram ⇄ gateway (long polling) ⇄ harness 127.0.0.1:8799 (HTTP + SSE)
```

## What you get

- **Talk to any bot** from Telegram: `/start` (or `/bots`) shows your roster as buttons; pick one, then just type. Replies stream in live — the message grows by edits while the bot writes.
- **Approve from your phone**: permission asks arrive as inline keyboards — `✅ Allow` / `❌ Deny` — wired straight to `/api/bots/:id/respond`. Questions offer the agent's choices as buttons, or free-text answers as a reply. Approvals from **every** bot come through (non-active bots are named); replies stream only for the bot you're talking to.
- `/stop` interrupts the active bot's turn.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Start the harness (`pnpm dev:server` or the app), then:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-… pnpm gateway:telegram
```

The token can also live in `~/.openmausbot/config.json` as `{"telegram": {"token": "…"}}`.

3. Open your bot in Telegram and send `/start`.

## Security model

The **first chat that sends `/start` becomes the owner** — the binding persists in `~/.openmausbot/telegram-gateway.json`, and every other chat is refused. This gateway can approve shell commands, so it is deliberately single-user. To rebind, delete the state file and `/start` again. Timed-out asks keep the harness's fail-closed behavior (deny with a keep-moving note); the gateway then tells you it was resolved without you.

## Scope (v1)

Text turns, streamed replies, approvals/questions, interrupt. Not yet: rooms, voice, images/screens, multi-user.
