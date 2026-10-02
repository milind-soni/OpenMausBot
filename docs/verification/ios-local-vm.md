# iOS Local VM view

Launch the isolated server, synthetic Local VM and companion sidecar:

```sh
node --experimental-strip-types scripts/verify-ios-local-vm.ts
```

The script starts the standard fake-engine server in a disposable home, a
synthetic `docker` that answers only inspection and the two screenshot execs,
an offline password-protected RFB desktop (`scripts/testing/fake-vnc-desktop.ts`)
published as the VM's noVNC port, and the companion sidecar pointed at that
server. It creates a bot named Vee
with `computer: "vm"`, checks that
`POST /api/bots/:id/local-computer/screenshot` returns a PNG, then prints the
sidecar address and a pairing code. The desktop is a captured Local VM session
(`scripts/testing/fixtures/local-vm-desktop.png`, an XFCE desktop with a terminal
open and nothing private on it); each capture types one more character at the
prompt, so a refresh is visible. It never reaches a
real container runtime, a VM, or the user's OpenMausBot data. Ctrl-C stops the
server and sidecar and removes the temporary data.

The sidecar listens on all interfaces like the real one, but only a device
holding a fresh pairing code from this run can use it.

Use a disposable simulator:

1. Build the `OpenMausCompanion` scheme with a team and local signing, as in
   the [iOS runbook](../../ios/TESTING.md), and install it on a fresh simulator.
2. Pair by opening
   `openmausbot://pair?address=127.0.0.1:PORT&code=CODE` in the simulator with
   the printed address and code, then tap **Connect**.
3. Open Vee, then its computer. With computer access off (the default), the view
   says to turn on **Allow computer view** in Settings → Remote access.
4. Enable it from the printed control address:
   `curl -X POST http://127.0.0.1:CONTROL/devices/DEVICE_ID/cloud-desktop`
   (`GET /state` on the same address lists the device id). The sidecar drops
   the device's connection so it reconnects with the new capability.
5. Without leaving the view, the idle VM's picture appears at the next
   30-second check, and another character appears at the prompt on each refresh
   after that. Revoking
   access (`DELETE` on the same address) clears the picture and brings the
   notice back at the next check.
6. Set another bot's computer to `off` on the harness; its computer view keeps
   the existing "only captured while it is working" message.
7. Back on Vee, tap **Take control**. The live desktop appears with a pointer
   ring, and the printed events address reports one authenticated connection
   and `controlHeld: true`.
8. Swipe on the trackpad: the pointer moves and `lastPointer` follows. Tap: the
   desktop paints a marker where the click landed, and the phone shows it.
9. Open the keyboard and type: `typed` shows the text.
10. **Hand Back**: `controlHeld` returns to `false` and **Take control** is
    offered again. Taking control and then sending the app to the background
    releases it too.
11. Take control again, then release it from the harness instead
    (`POST /api/bots/BOT/computer/control` with `{"action":"release"}`): within
    a few seconds the sidecar's lease check fails, the relay closes, and the
    phone shows the desktop as disconnected.

The companion route and capability checks are covered by
`companion/test/routes.test.ts` and `companion/test/proxy-response.test.ts`;
the join and relay rewrite by `companion/test/viewer-relay.test.ts` and
`server/index.test.ts`; the client calls by
`ios/Tests/CompanionCoreTests/LocalVmScreenshotClientTests.swift` and
`LocalVmControlClientTests.swift`; and the VNC protocol, byte for byte, by
`RFBTests.swift`.

## Phones paired with the server directly

A phone paired with `openmausbot serve` itself (a headless server, reached over
Tailscale Serve or a tunnel) has no companion sidecar, so nothing rewrites the
VM's noVNC address for it. The join route answers such a phone differently: a
path on the server's own authenticated desktop proxy
(`/api/desktop-viewer/local/shared/websockify` for the shared VM; per-bot
targets likewise), bound to the phone's control lease and to the
conversation whose VM seat the join picked, plus the VNC password. The phone never sees a loopback address, and the
proxy re-checks the lease and the session every few seconds and closes the
socket when either lapses. Computer access is the pairing's scope: a Full
access pairing (`openmausbot pair`) may; a chat-only one (`--client`) is
answered 403, which the phone shows as computer access being off.

Phone control is unavailable in pool mode, through either connection path.
A bot's control hold does not reserve a pool seat against other bots. The
join route refuses pool mode, and the desktop proxy independently refuses
lease-bound pool URLs before reading credentials or opening a socket.
Shared and per-bot desktops remain supported. Reserving a pool seat for the
whole viewer lifetime is required before enabling interactive pool viewers.

Check it against the same fixture, talking to the printed `harness` address
rather than the sidecar. With `BOT` and `THREAD` from the fixture's output and
`LEASE` any name of 16 to 120 URL-safe characters:

1. Pair a phone session: `POST /api/auth/pairing` with `{}` (loopback is the
   owner), then `POST /api/auth/pair` with the code. Use its token as a bearer
   below. Pair a second one with `{"scopes":["client"]}` for the chat-only case.
2. Chat-only: `POST /api/bots/BOT/local-computer/join?threadId=THREAD&controlLeaseId=LEASE`
   and a WebSocket upgrade of
   `/api/desktop-viewer/local/shared/websockify?botId=BOT&threadId=THREAD&controlLeaseId=LEASE`
   both answer 403.
3. Full access, before taking control: the join answers 409 "Take control of
   this computer first", and so does the proxy.
4. `POST /api/bots/BOT/computer/control` with `{"action":"take","controlLeaseId":"LEASE"}`,
   then the join: 200 with `socketPath` and `password`, and no `joinUrl` or
   `127.0.0.1` anywhere in the body.
5. Upgrade `/` + `socketPath` with the bearer: 101, and the first bytes are the
   desktop's `RFB 003.008` greeting. The events address shows one connection
   and `controlHeld: true`.
6. `POST /api/bots/BOT/computer/viewer-close` answers `{"closed":true}` and the
   socket closes at once; a viewer-close for another bot leaves it open. Open it again, then release the lease
   (`{"action":"release","controlLeaseId":"LEASE"}`): the socket closes within
   about five seconds, and both the join and the proxy answer 409 again.
   `POST /api/auth/logout` on the phone's session closes an open socket
   immediately.
7. The sidecar path is unchanged: the same join from loopback, without a
   bearer, still returns the raw `joinUrl` for the sidecar to rewrite.

The proxy's lease binding is covered by `server/routes/desktop-viewer.test.ts`
and the route's answers to direct sessions by `server/index.test.ts`; the
phone's acceptance of only this proxy shape by `LocalVmControlClientTests.swift`.
