# Embedded desktop server recovery

Run the focused checks and real Electron utility-process fixture:

```sh
node --test electron/server-supervisor.node-test.mjs electron/server-boot-probe.node-test.mjs
pnpm build:server
node scripts/verify-server-recovery.mjs
```

The fixture supports macOS and Linux (Linux needs a graphical session, or
`xvfb-run -a node scripts/verify-server-recovery.mjs`). It creates disposable
homes and profiles, copies the bundled server outside the repository, chooses
fresh loopback ports, and configures only the repository's inert fake engine.
It never launches `electron/main.mjs`, a real computer/browser driver, the
operator's installed app, or their data directory. It accepts no server URL.

Three separate Electron parents exercise the production supervisor, PID health
probe, parent-held data-directory lease, private approval coordinator, and built
server:

- Crash after a fake engine accepts a pinned user turn. Verify immediate
  unavailability, a different PID on the same port, the unchanged parent lease,
  the replacement's delegated child lease, and authenticated mutations.
  The old child's pending approval must reject; a new approval must succeed.
  The shared control surface records `wait` and bounded `messages` results,
  while the fake engine's prompt ledger proves the interrupted turn was not
  resent. The intentionally hung fake engine is explicitly reaped by its exact
  fixture-recorded PID.
- Quit through Electron's actual `before-quit` event during the first backoff.
  Wait beyond that retry deadline and verify no replacement was spawned.
- Crash the initial child and every replacement. Verify exactly three retries
  with the production 1/2/4-second delays, then a terminal exhausted state.

The printed evidence directory retains each scenario's JSON receipt and log.
Successful cleanup removes only the copied server, temporary UI, and fixture
homes. Keep the receipts and exact command sequence when reporting a pass.
Unit checks also cover stable-uptime budget reset, old exit/ready results,
pending-boot shutdown, repeated quit requests, failed probes, and refusing to
fork a sibling when a child cannot be reaped.

Limits: this is an owned-child smoke, not a complete packaged desktop or
renderer test. It does not prove native failure-dialog presentation, renderer
draft preservation, or real provider/computer-helper cleanup after SIGKILL.
An interrupted turn remains interrupted; recovery does not synthesize a reply.
Existing routine scheduling and persisted delegation policies are unchanged.
