# iOS Local VM view

Launch the isolated server, synthetic Local VM and companion sidecar:

```sh
node --experimental-strip-types scripts/verify-ios-local-vm.ts
```

The script starts the standard fake-engine server in a disposable home, a
synthetic `docker` that answers only inspection and the two screenshot execs,
and the companion sidecar pointed at that server. It creates a bot named Vee
with `computer: "vm"`, checks that
`POST /api/bots/:id/local-computer/screenshot` returns a PNG, then prints the
sidecar address and a pairing code. Each capture returns a different synthetic
desktop (the coloured tile changes), so a refresh is visible. It never reaches a
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
   30-second check, and the tile changes on each refresh after that. Revoking
   access (`DELETE` on the same address) clears the picture and brings the
   notice back at the next check.
6. Set another bot's computer to `off` on the harness; its computer view keeps
   the existing "only captured while it is working" message.

The companion route and capability checks are covered by
`companion/test/routes.test.ts` and `companion/test/proxy-response.test.ts`;
the client call and data-URL decoding by
`ios/Tests/CompanionCoreTests/LocalVmScreenshotClientTests.swift`.
