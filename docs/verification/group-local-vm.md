# Group and Goal Local VM routing

Related: #430. This change gives a room member its configured Local VM; it does
not create a room-owned desktop or a room Computer panel.

The pre-existing direct-turn stale lease after a missing terminal event is
tracked separately in [#860](https://github.com/milind-soni/OpenMausBot/issues/860).
That follow-up needs distinct direct invocation identities and tests protecting
a replacement turn from an old watchdog callback; it is outside this room slice.

`runGroupMemberTurn` now mounts the speaking bot's computer MCP and prompt after
claiming the same target-scoped lease used by direct turns. Setup cancellation
and terminal cleanup release the lease and setup ownership. Timed-out or stalled
providers keep the desktop through the existing interrupt grace period; the
fallback then removes lease bookkeeping before releasing the bot. Computer
capabilities are bound to the exact VM claim and stop working on expiry or
member handoff.

## Opt-in isolated acceptance

Prepare the managed desktop image on an explicitly selected Podman test machine.
Build the renderer (`node node_modules/vite/bin/vite.js build`), set
`OMB_VERIFY_PODMAN` to the absolute executable path and `OMB_VERIFY_MACHINE` to that connection,
then run:

```sh
node --experimental-strip-types scripts/verify-group-vm.ts
```

The launcher creates a temporary home, data directory, explicit loopback server
and fake Claude engine. It grants that fixture access to the selected engine,
creates only fixture-specific desktop targets and removes them afterward.
Do not substitute a live application URL or data directory. The JSON receipt
records the exact MCP target for each speaker, the computer-off case, and
revocation of each settled speaker's computer capability. It is written to
`.omb-scratch/verification-logs/group-vm-routing.json` only after cleanup succeeds.
The script removes the previous dump before every send and requires every Goal,
including computer-off, to settle. Cleanup errors fail the run.

2026-09-07 on Windows/WSL2, rootless Podman 5.8.3:

- Two Goal speakers received different matching desktop targets and settled.
- A speaker switched to `computer: off` received no computer MCP.
- Each settled speaker's computer-control capability returned HTTP 401.
- Six regression scenarios run a real isolated server and fake Claude, replacing
  only the container boundary: failed readiness, Stop during readiness, shared
  member handoff/impersonation, lease expiry, timeout, and stall cleanup.
- Before the follow-up fix, the same readiness, expiry, and timeout regressions
  failed on `a9ec061c`; after the fix they pass.
- After integrating upstream browser engine step 2 (`b3c2f74b`): Goal, browser,
  lease, and fixture-launcher coverage passed 68 tests with 1 existing TODO.
  The dedicated real-server browser-engine room-mount test also passed.
- Server TypeScript checking and server bundling passed.

This fake-engine fixture proves routing, not model-driven clicks or screen
streaming. Firefox sandbox compatibility and Japanese guest fonts are separate
changes. Full repository coverage is provided by PR CI; this local recipe is
targeted.

Run the regression coverage without a container engine:

```sh
node node_modules/vitest/vitest.mjs run server/group-local-vm.e2e.test.ts server/local-vm-lease.test.ts server/group-goal-run.test.ts server/group-goal-run.e2e.test.ts server/group-goal-wait-cap.e2e.test.ts server/control-omb.test.ts
```

The test-only Node loader in `server/testing/group-local-vm-hooks.mjs` replaces
container status and controls lease expiry and watchdog/deadline timing inside
that child process.
Production launchers never import it. No provider or live desktop is used by
these regression tests; the opt-in Podman acceptance above covers real routing.
