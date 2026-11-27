# Browser WebSocket delivery

Direct browser chat requires a paired or signed-in browser session, including on
localhost. A WebSocket becomes live after a valid hello. After three seconds
visible and online without a hello, or after a disconnect, the browser retries
over WebSocket with backoff and resumes from its last committed cursor. A proxy
blocking WebSocket upgrades prevents live chat delivery until the socket can
connect. Desktop and encrypted phone relay clients keep their existing transports.

Build and run the isolated browser check:

```sh
pnpm build
OMB_CDP_CHROME=/usr/bin/chromium node scripts/verify-websocket-browser.ts
```

The check pairs Chromium with a disposable fake-engine server serving `dist`.
It opens the root URL without a transport query and sends `probe0`, `probe1`,
and `probe2` through the real composer. It checks a WebSocket reply, closes the socket during the second reply, and temporarily blocks socket
creation before the third reply to verify WebSocket retries without SSE. Every prompt must appear
once in storage. Stored reply paragraphs must appear once and in order in the
rendered message.

The server authorization, heartbeat and revocation check is separate:

```sh
OMB_CDP_CHROME=/usr/bin/chromium node scripts/verify-websocket-feed.ts
```
