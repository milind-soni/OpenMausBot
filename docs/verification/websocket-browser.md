# Browser WebSocket pilot

The direct browser remains on SSE unless its URL contains `?liveTransport=auto`.
Auto tries a same-origin WebSocket and accepts it only after a valid hello. A
silent first connection falls back after three seconds spent visible and online.
A healthy socket gets one replay reconnect before the page stays on SSE. Reload
with `?liveTransport=sse` to select SSE explicitly. Relay and desktop connections
keep their existing transport.

Build and run the isolated browser check:

```sh
pnpm build
OMB_CDP_CHROME=/usr/bin/chromium node scripts/verify-websocket-browser.ts
```

The check pairs Chromium with a disposable fake-engine server serving `dist`.
It sends `probe0`, `probe1`, and `probe2` through the real composer. It checks a
WebSocket reply, closes the socket during the second reply, and blocks socket
creation for the third reply to prove SSE fallback. Every prompt must appear
once in storage. Stored reply paragraphs must appear once and in order in the
rendered message.

Append `--serve` to leave that server running after the checks pass. Its printed
pairing link selects auto after connecting. Open **Socket demo** and send
`probe0`, `probe1`, or `probe2` for a scripted response. This fixture uses no real
provider credentials and cannot assess internet or company-network connectivity.
Stop the foreground process with Ctrl-C to remove its temporary data.

The server authorization, heartbeat and revocation check is separate:

```sh
OMB_CDP_CHROME=/usr/bin/chromium node scripts/verify-websocket-feed.ts
```
