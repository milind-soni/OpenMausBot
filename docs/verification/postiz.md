# Postiz connection

The Postiz card in Apps (the Social category) connects the social media
scheduler [Postiz](https://postiz.com) as one MCP server named `postiz`, so the
MCP gate, each bot's server selection and a Team Cloud's scopes treat it like
any other server. OpenMausBot only calls Postiz's public
MCP and OAuth endpoints; Postiz is AGPL-3.0 and none of its code is copied.

- **Sign in with Postiz** (the default) uses Postiz Cloud's
  `/mcp-oauth-dynamic` endpoint with dynamic client registration and PKCE,
  through the existing MCP sign-in (`server/mcp-oauth.ts`): the loopback
  callback on the desktop, the Cloud's own https address on a Cloud.
- **Use an API key instead** sends the organisation key as a bearer token to
  `<address>/mcp`, Postiz Cloud unless the person enters their own Postiz
  server. The key is checked (MCP `initialize` and `tools/list`) before it is
  saved, saved like other app keys (the desktop's encrypted store, the server's
  config on a Cloud), and sent only to the entry at the address it was saved
  for (`server/postiz/connection.ts`).

## Isolated checks

```sh
pnpm exec vitest run server/postiz.e2e.test.ts server/postiz/service.test.ts server/postiz/connection.test.ts src/components/PostizCard.test.ts src/components/PluginsPanel.navigation.test.ts src/lib/app-catalog.test.ts src/lib/ready-bots.test.ts
```

`server/postiz.e2e.test.ts` runs a disposable fake-engine server beside two
stand-in Postiz backends (`server/testing/fake-postiz.ts`, Postiz Cloud and a
person's own Postiz) and proves, for both ways of connecting:

- the sign-in registers a client, follows Postiz's consent back to the loopback
  listener and stores a token; the key path refuses a wrong key, an http or
  credential-bearing address, an unreachable server and a server that is not
  Postiz, each in plain words, and saves nothing then;
- the bot's next turn mounts `postiz` (without Claude Code's `alwaysLoad`, so it
  loads on demand), and a scripted `schedulePostTool` call reaches the stand-in
  with the right bearer;
- the token or key appears in no API answer, transcript, prompt, server log or
  data file except the one that stores it (`mcp-oauth.json`, or `config.json`
  off the desktop);
- a revoked token shows Reconnect and a revoked key shows as refused after
  `POST /api/postiz/check`;
- Disconnect, or removing the key, takes `postiz` out of the next turn.

## Screenshots

```sh
OMB_VERIFY_PLAYWRIGHT=/path/to/playwright/index.mjs OMB_VERIFY_BROWSER_CHROME=/path/to/chrome node --experimental-strip-types scripts/verify-postiz.ts
```

This drives the real Apps modal in headless Chromium against the same stand-ins:
the Social category, the sign-in waiting and connected states, a refused key,
the key form and the key connection. Screenshots default to
`/tmp/omb-postiz-evidence`; override with `OMB_UI_EVIDENCE_DIR`.

## Live acceptance (a Postiz account owner)

None of the above reaches Postiz. With a real account:

1. Apps → Social → Postiz → Connect on the desktop. Postiz's consent page opens
   at platform.postiz.com; approve it and check the card says it is connected.
2. Ask a bot to list your Postiz channels, then to draft a post. Check it shows
   in Postiz's calendar as a draft, and that the bot asked first if its approval
   level asks.
3. On a Cloud, connect the same way. If Postiz refuses to register the Cloud's
   https address, the card falls back to pasting the redirect address; note
   which happened.
4. Disconnect the app in Postiz; Apps → Postiz should then offer Reconnect.
5. Use an API key instead (Postiz → Settings → Public API), with and without
   your own server's address; a wrong key must be refused in plain words.
6. On a Team Cloud, connect with Only for me, then have a teammate connect their
   own Postiz from their team page.
