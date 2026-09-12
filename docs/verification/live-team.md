# Live Team studio verification

## Run the workflow

Install the repository dependencies and use Node 24 or later. From the repository
root, run:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/live-team-ui.e2e.test.ts
```

The workflow launches an isolated server with a disposable home, fake engine,
and browser session. It exercises the real app and server without using live
accounts or the operator's running app. Run renderer fixtures sequentially.

Optional flags:

- `OMB_UI_ELECTRON=1` adds the hidden Electron renderer smoke test. It requires
  the installed Electron binary and a graphical host or virtual display.
- `OMB_UI_VIDEO=1` records the browser workflow and requires ffmpeg on PATH.
- `OMB_UI_EVIDENCE_DIR` overrides the default artifact directory,
  `.omb-scratch/live-team/evidence/`.

## Coverage

The browser workflow checks brief assignment by drag and keyboard, explicit
sending, retry after a rejected send, questions, handoffs, result
navigation, concurrent tasks, interrupted and failed turns, and passive
workstation navigation. It also checks pagination, search, empty states,
responsive layouts, reduced motion, focus restoration, and stale-data recovery.

The Electron smoke checks saved room preferences, workstation return focus,
suppression of a remembered Browser tab, and brief input at 200% zoom.
Screenshots, request records, and renderer errors are written to the ignored
artifact directory. Failed runs retain diagnostics. The fixture removes its
temporary data and prints the retained server log path.

## Related checks

```sh
pnpm exec vitest run server/live-team.test.ts src/lib/live-team.test.ts server/delegations.test.ts server/peer-approval.test.ts src/lib/team-map.test.ts src/state/store.test.ts src/lib/local-computer.test.ts server/request-auth.test.ts
pnpm exec vitest run server/independent-threads-api.test.ts -t "keeps a Group"
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/cloud-preview.e2e.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:check
pnpm build
```

The metadata tests cover ownership filtering before pagination. The group test
checks interrupted results after room-level Stop. The cloud fixture checks
watch-mode controls and explicit startup using simulated cloud transport.

These fixtures do not verify a packaged app, real cloud provisioning, host
capture, or native Windows/Linux behavior. The Electron preload replaces OS
integration. For repository-wide coverage, also run `pnpm test`. Previously
observed baseline failures in `server/control-omb.test.ts` (installed-engine
detection) and `server/engine-install.test.ts` (TERM/KILL timing) require checking
against the unchanged baseline before attributing them to Live Team.
