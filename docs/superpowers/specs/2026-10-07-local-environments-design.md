# Local Environments (switchable setups) — design

## Summary

One desktop installation can be running only one configuration at a time: the
bots, providers, groups, routines and history under `~/.openmausbot`. Users who
work on several unrelated projects (for example a ham-radio bot team and a
mobile-app bot team) want completely separate teams, model choices, MCP servers
and histories, and want to switch between them at the start of a work session.

Every piece of that isolation already exists in code. `DATA_DIR` resolves once
at server boot from `OMB_DATA_DIR` (`server/config.ts:963`), and every state
file derives from it. The desktop shell already has an "environments" registry
(`electron/environments.cjs`, `DesktopWorkspaceSwitcher.tsx`) that switches
between "This computer" and paired remote servers — but exactly one local
configuration is possible. This design adds **named local environments**:
additional data directories, switchable from the existing switcher, one active
at a time, with a ~15 s in-app restart. The server binary is unchanged.

## Goals

- Let a user create, name, switch between, and forget several local setups on
  one computer, from the existing sidebar switcher.
- Full isolation per environment: bots, provider instances and API keys, MCP
  servers, groups, routines, message history, memories, checkpoints, events.
- Safe handoff: only one process may hold an environment; a failed switch must
  leave the user exactly where they were.
- Zero migration: the current `~/.openmausbot` remains "This computer" and
  behaves exactly as today.
- Reuse the data-dir lease so two app processes can never share an environment.

## Non-goals

- Running two environments at the same time (each stays one app, one server).
- Hot-swapping inside a live server process (import-time bindings, singletons;
  a restart is the mechanism).
- Copying or cloning an existing environment into a new one (the copy
  installation feature covers moving setups; a guided copy is a fast follow).
- Per-environment sync, cloud storage, or mobile/companion per-environment
  pairing (v1: companion keeps pairing to whichever environment is active).
- Multi-tenancy or sharing: environments are local and single-user, like today.

## Terminology

Per the product vocabulary (`src/locales/words.test.ts`): a running app is an
installation; this feature's units are **environments** — the word the code
already uses (`environments.cjs`, `environment-id` per data directory). User
copy never says "workspace". A bot's directory stays a "folder".

## Data model

`environments.json` (Electron userData) grows from
`{version: 1, environments: [{id, name, origin}], activeId}` to:

```json
{
  "version": 2,
  "environments": [
    { "id": "local-aprs", "kind": "local", "name": "APRS Chat",
      "dataDir": "/Users/me/.openmausbot-aprs" },
    { "id": "a1b2c3", "kind": "remote", "name": "Office box",
      "origin": "https://box.example" }
  ],
  "activeId": "local-aprs"
}
```

- Migration: `version: 1` entries are all remote; reading v1 stamps
  `kind: "remote"`. The implicit singleton `local` ("This computer",
  `~/.openmausbot`) stays addressable without an entry.
- Default path for a new environment: `~/.openmausbot-<slug>` — the sibling
  pattern the companion app already uses (`~/.openmausbot-companion`). Never
  nested inside another environment's directory (rejected at create time).
- A custom directory is accepted only through the native folder picker; the
  path must be absolute, non-nested in any registered environment, and not the
  default directory.

## Switch flow

All logic lives in a pure, testable module (`electron/environments.cjs`
grows; the process choreography goes to a new `electron/environment-switch.mjs`
wired thinly from `main.mjs`).

1. Renderer asks to switch (existing IPC surface, extended). Confirm dialog
   states the restart and ends active turns.
2. Main sets a switching flag (supervisor backoff must not fight the switch),
   stops the child server, waits for exit, releases the current data-dir lease.
3. Probe the target: missing directory that was never created → create it
   (fresh environment seeds itself via the server's own `ensureDirs`); path
   whose parent volume is absent (e.g. an unmounted USB drive) → abort,
   re-acquire the old lease, restart the old child, tell the user.
4. Acquire the lease on the target (a held lease means the environment runs
   elsewhere → abort the same way).
5. Fork the server child with `OMB_DATA_DIR` set to the target (the launch env
   is already rebuilt per `startServerOn` call); health-probe as at boot.
6. Health OK → persist `activeId`, reload the window to the local origin.
   Health fails → kill the child, re-acquire the old lease, restart the old
   environment, surface the error.

`activeId` is persisted only after a healthy probe, so a crash mid-switch
boots the previous environment. If the app later starts into an environment
whose server never becomes healthy, the startup screen offers "Open This
computer instead" (resets `activeId`).

Ports are unchanged (8799 with fallbacks) — environments swap sequentially, so
there is no port contention.

## Create / forget UX

Settings → "Connected environments" (extends the existing page): a "New
environment" form (display name, optional folder override) and, per named
environment, Open in Finder, Show data folder size, and Forget (deletes only
the registry entry; the directory survives with a "keep files?" choice — delete
requires typing the name). "This computer" is never forgettable.

The sidebar pill lists: This computer, named local environments, remote
servers, each labeled. Switching to a named environment shows the same
confirm.

## Error handling

- Target path unavailable (unmounted volume) → dialog, stay put, entry marked
  "missing" until the path reappears.
- Lease held by another app process → dialog naming the environment, stay put.
- New environment crashes at boot repeatedly → startup-screen fallback to This
  computer; the entry stays for debugging.
- Turns in flight at switch time: confirm dialog warns; graceful SIGTERM gives
  the server its normal shutdown flush (ledgers, `messages.db` WAL checkpoint).

## Server changes

None. `OMB_DATA_DIR` already isolates everything, `environment-id` is
per-directory already, and the CLI attach check (`server/cli.ts:367`) already
refuses to attach across directories.

## Copy / i18n / docs

- New `en.json` keys only (other locales fall back to English per
  `docs/localization.md`); wording passes `words.test.ts` gates.
- Tests: `environments.node-test.mjs` v2 migration + local entries + guard
  rules; `environment-switch` unit tests with fake child/lease; an
  e2e-style test booting two disposable data directories in sequence via
  `launchVerificationServer`; renderer tests for the switcher list and the
  settings form.
- Docs trio per `CONTRIBUTING.md`: this spec, `docs/plans/local-environments.md`,
  and `docs/verification/local-environments.md`.

## Upstream integration

Proposed issue: "Switch between multiple local environments (separate bots,
providers and settings on one machine)". Prior art to cite in the issue:
`OMB_DATA_DIR` + `--data-dir`, the environments switcher, fleet (server-side
multi-workspace), `workspace-backup.ts`. Fleet proves the model; this gives
desktop users the same capability without systemd.

## Effort

Estimated 800–1200 diff lines: `environments.cjs` (+ tests),
`environment-switch.mjs` (+ tests), `main.mjs` wiring, `DesktopWorkspaceSwitcher`,
`ConnectedWorkspacesSettings`, `en.json`, docs. No server changes. One focused
implementation pass; CI is the authoritative gate.
