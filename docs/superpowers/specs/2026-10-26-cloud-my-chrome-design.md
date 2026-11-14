# My Chrome on My Cloud

**Asked for (Omkar, 2026-10-26):** on My Cloud the Browser profiles dialog greys out My Chrome. Bots should have both
options anywhere: their own browser, or the person's Chrome on their Mac or PC, whenever that computer is online. A
Cloud bot may use the Mac while it is live.

## Behaviour

- **Mac or PC (desktop app):** Settings → MausBot Cloud → what's lent gets a fourth switch, **Your Chrome**, off by
  default and never part of the default grant. While it is on and lending runs, My Cloud's bots can drive the Chrome
  on this computer over the device link that already carries the internet connection.
- **My Cloud (personal Cloud home only, never a Team Cloud):** once a computer lends its Chrome, a browser profile's
  Browser picker offers My Chrome again. It says which computer the profile uses and whether that computer is online.
  When nothing lends Chrome, the dialog explains how to lend it instead of only saying it is unavailable.
- **A bot on a My Chrome profile on My Cloud** acts inside the person's real, signed-in Chrome, as it does on the
  desktop. When it can't, its tool call says why in one line it can pass on: the computer is offline, Chrome isn't open
  with remote debugging on, Chrome didn't accept the connection (it may be waiting for Allow), or the computer stopped
  lending Chrome. It never falls back to the built-in browser, because that browser has different sign-ins.
- **Who may use it:** exactly the turns that may use the lent computer today (`cloudHomeLendingRefusal` plus the
  memory check, through `mayLend`). A conversation someone else wrote in gets "Someone else wrote in this conversation,
  so it can't use your Chrome. Start a new conversation to use it."
- **Idle:** a connection to the person's Chrome that no bot has used for the browser idle time (default 10 min) is
  closed, so Chrome stops showing it as controlled. The next tool call reconnects by itself.

## How it works

```
agent-browser (Cloud) ──ws──▶ Cloud door 127.0.0.1:<port>/devtools/browser/<token>
      ──device link stream {chrome:true}──▶ Mac door ──▶ Chrome's own DevTools port (from DevToolsActivePort)
```

1. **Link protocol:** a stream opens either `{host, port}` (internet, unchanged) or `{chrome: true}`. The Cloud never
   names a host or port for Chrome.
2. **Mac door (`electron/device-chrome.mjs`):** reads Chrome's `DevToolsActivePort` from Chrome's own data folders
   (Google Chrome, Chrome Canary, Brave), connects to `127.0.0.1:<that port>` only, and lets through one HTTP request:
   a WebSocket upgrade to `/devtools/browser…` (rewritten to Chrome's real browser path) or `/devtools/page/<id>`
   (kept). It rewrites `Host` to `127.0.0.1:<port>` and drops `Origin`. Anything else gets `403` and the stream ends.
   After the upgrade, bytes pass unchanged.
3. **Mac's own check:** the computer opens a Chrome stream only while its own grant lends Chrome, and an internet stream
   only while its grant lends the internet connection. The link stays open while either is lent.
4. **Cloud door (`server/browser/lent-chrome.ts`):** one loopback listener per browser session. agent-browser gets
   `AGENT_BROWSER_CDP=ws://127.0.0.1:<port>/devtools/browser/<token>`. The 32-byte token keeps other local clients out.
   Each connection is checked against the session's last holder (`mayLend`), then routed through the newest online
   link of the lender that lends Chrome.
5. **Gate on reuse:** agent-browser keeps one connection open across turns, so when a turn that may not lend takes the
   browser (`TurnResources.onClaim`), that session's door connections are dropped. Each tool call on such a session is
   refused with the someone-else sentence before it reaches the engine.

## Verified facts (2026-10-26)

- agent-browser 0.37.0 takes `AGENT_BROWSER_CDP=ws://…/devtools/browser/<id>` and connects without `/json/version`.
- Chrome 155 answers `404` to a browser path that isn't its own, so the Mac must rewrite the path.
- agent-browser holds one connection per session. After it is dropped, the next command reconnects by itself. While
  the route refuses, a command fails with `CDP WebSocket connect failed: …`, and it recovers once the route is back.
- agent-browser auto-connect on macOS looks under `Library/Application Support/{Google/Chrome, Google/Chrome Canary,
  BraveSoftware/Brave-Browser}`.

## Out of scope

- Phones (they show no browser profiles), Team Clouds, `browserEngine.attachCdpUrl` behaviour (unchanged).
- Choosing among several lending computers: the newest online one that lends Chrome is used.
- Asking Chrome for permission on the person's behalf: Chrome's own Allow prompt stays the person's.

## Known limit

A process running as the server's own user on the Cloud could read the token from agent-browser's environment.
That user can already read the server's data, so this is no new reach. The token is there to keep out other users and
port probes.
