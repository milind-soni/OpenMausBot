# Plan: Local environments

Status: implemented (Oct 2026, `feat/local-environments`). Full design:
[2026-10-07 local environments design](../superpowers/specs/2026-10-07-local-environments-design.md).
Manual checks: [verification recipe](../verification/local-environments.md).

## Problem

One desktop installation runs one configuration at a time: the bots,
providers, groups, routines and history under `~/.openmausbot`. People who
work on several unrelated projects — a ham-radio bot team and a mobile-app
bot team, say — want completely separate teams, model choices and histories,
and want to pick the right one at the start of a work session.

## Shape

**Named local environments**: additional data directories the same
installation can restart onto, managed beside the saved servers, one active
at a time. Creating one registers a name and a data folder ("My environment"
→ `~/.openmausbot-my-environment`, or a folder chosen through the native
picker); switching stops the app's server child, moves it onto the target
directory, health-probes it, and reloads the window — roughly fifteen
seconds, and a failed switch leaves you exactly where you were. The current
data folder stays "This computer" and behaves exactly as before: zero
migration, and it is never forgettable. The server itself is unchanged —
`OMB_DATA_DIR` already isolates everything, and the per-directory
`environment-id` already tells two environments apart.

Everything the environment holds is isolated with it: bots, provider
instances and API keys, MCP servers, groups, routines, message history,
memories and checkpoints.

## Where it lives

| Piece | File |
|---|---|
| Registry: versioned entries, v1→v2 migration, name/path guard rules | `electron/environments.cjs` |
| Switch choreography: stop child, hand the data-dir lease, probe, persist only on success | `electron/environment-switch.mjs` (pure, dependency-injected) |
| Wiring: IPC surface, one-switch mutex, supervisor pause, rollback restart, boot fallback to This computer | `electron/main.mjs` |
| "Environments on this computer" — create form, Switch, Forget with a keep-or-delete-files choice | `src/components/ConnectedWorkspacesSettings.tsx` (Settings → Servers) |

Rules that hold the model together:

- A directory is absolute or it is nothing; it may not be the default
  directory and may not sit inside a registered environment's directory.
- `activeId` is written only after the target server answers its health
  probe, so a crash mid-switch boots the previous environment; an
  environment that never comes up at boot falls back to This computer once
  and says so.
- The data-directory lease moves with the switch, so two app processes can
  never share an environment; a held lease means "running elsewhere" and the
  switch aborts.
- Creating and switching are packaged-installation features: an unpackaged
  dev run returns `dev`, and the card does not render.

## Non-goals

Same as the spec: two environments at once, hot-swapping inside a live
server, copying or cloning an existing environment (the Copy installation
feature covers moving setups), per-environment cloud sync or companion
pairing, and multi-tenancy.
