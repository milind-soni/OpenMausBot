# Bots changing app settings (`app_settings`)

Run the isolated recipe:

```sh
pnpm exec vitest run server/app-settings.e2e.test.ts
pnpm exec vitest run server/app-settings server/routes/app-settings.test.ts
pnpm exec tsc -p tsconfig.server.json --noEmit
```

The e2e test starts its own temporary server through `launchVerificationServer`
with the scripted Claude fixture. It creates one bot, stops that exact server,
puts the bot on Full access in its disposable `bots.json`, and starts it again
on the same temporary home. The scripted turns call `app_settings` through the
real injected agents MCP proxy, so every guard runs in the real server. The
owner's Change answer comes from a paired admin session, as a paired phone's
would. Nothing touches live app data.

## What it checks

- **Safe.** A Full-access owner turn finds "turn timeout", sets
  `rooms.turnTimeoutMinutes` to 45 and gets an applied card with Undo.
  `config.json` and `GET /api/config` show 45. `POST /api/threads/:id/undo`
  sets back the earlier value, which is the default on a fresh install.
- **Confirm.** Setting `providers.xai.url` on Full access posts a
  "Change xAI address?" card with Change and Cancel, and nothing changes while
  it waits. A local Allow is refused while the bot works, so a bot's own shell
  cannot approve its card. Cancel leaves the setting alone and tells the bot
  not to retry. Change from the owner's paired device applies it. The decision
  log records each card and answer.
- **Secret.** `set keys.xaiApiKey` with a value is refused. Without a value it
  posts the secure key card. The key is in no tool result, message, decision
  row or saved config.
- **Owner-only.** `set bots.approvalModes` is refused with where the owner
  changes it.
- **Stop.** Stopping a turn whose provider-address card waits closes the card as
  unavailable at once; a later Change applies nothing, and the next turn can ask again.
- **Window preferences.** A skin change is refused while no app window's live
  stream (`/api/events?window=1`) is open, applied once one connects, refused
  after it closes, and applied again on reconnect.
- **AI engines.** A Full-access bot's Ollama add waits on a "Change AI engines?" card and Cancel adds nothing. An
  OpenAI-compatible add with a key in the value is refused; with `keyFrom` naming the saved OpenRouter key it posts a
  card naming the address and the key it will receive, adds nothing while it waits, and Change adds it with the saved
  key. `get` lists it with no key, and removing it takes another Change. The key is in no tool result, message or
  decision row.
- **Not the owner's turn.** A webhook's run can `get` a setting, but its `set`
  is refused and the setting stays as it was.

## Limits

The scripted engine stands in for the model. This recipe does not show whether
a real model follows the tool's instructions. It checks server and proxy
behaviour, not the rendered cards or how phones draw them. A second open card, a Stop landing after Change,
the refusal to remove an engine in use, and the 9-minute timeout of an unanswered card are covered only by
the unit tests in `server/app-settings/host.test.ts`. The fixture's engine reports no tool
activity lines, so the secret check reads the thread as the fixture writes it.
