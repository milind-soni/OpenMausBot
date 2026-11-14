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
- **No card to answer.** Setting `providers.xai.url` applies at once on Full
  access, posts an applied "Changed xAI address" card with Undo, and logs one
  `auto-approved` row with source `app-settings`. Undo clears it again.
- **Secret.** `set keys.xaiApiKey` with a value is refused. Without a value it
  posts the secure key card. The key is in no tool result, message, decision
  row or saved config.
- **Owner-only.** `set vault.logins` is refused with one line saying where the
  person changes it.
- **A bot's own settings and a config value.** One turn renames the bot through
  `bots.name` and sets `profile.name`. Both apply at once through the real
  `PATCH /api/bots/:id` and `PUT /api/config`, and Undo puts each back.
- **Approval mode.** The Full-access bot puts itself on Ask; the bot and every
  thread move to Ask at once, and Undo puts it back on Full access.
- **Window preferences.** A skin change is refused while no app window's live
  stream (`/api/events?window=1`) is open, applied once one connects, refused
  after it closes, and applied again on reconnect.
- **AI engines.** An OpenAI-compatible add with a key in the value is refused;
  with `keyFrom` naming the saved OpenRouter key it is added at once with that
  key. `get` lists it with no key. Removing it is refused with one line saying
  the person does that in Settings → AI, and Undo on the add removes it. The key
  is in no tool result, message or decision row.
- **Not the owner's turn.** A webhook's run can `get` a setting, but its `set`
  is refused and the setting stays as it was.

## Limits

The scripted engine stands in for the model. This recipe does not show whether
a real model follows the tool's instructions. It checks server and proxy
behaviour, not the rendered cards or how phones draw them. The desktop-bridge
preferences (remote access, open at login, window frame, sidebar colour, talk
shortcut, product emails) are covered only by `src/lib/window-prefs.test.ts`
with a stubbed bridge, not a packaged desktop app. Undo of the per-bot,
browser-profile and library-skill settings, turning a way in on but not off,
and the owner-only list are covered by the unit tests in
`server/app-settings/host.test.ts`. The fixture's engine reports no tool
activity lines, so the secret check reads the thread as the fixture writes it.
