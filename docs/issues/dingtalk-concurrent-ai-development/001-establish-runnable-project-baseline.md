# [001] Establish runnable project baseline

**Type**: AFK  
**Status**: DONE
**Blocked by**: None — can start immediately  
**PRD**: `dingtalk-concurrent-ai-development-prd.md`

## What to build

Establish the confirmed implementation baseline before product behavior is added. Revise the PRD to v1.1 with the single-Owner and first-milestone boundaries, import the OpenMausBot history at baseline `7417725`, retain its original remote as `upstream`, and provide a headless service that can open a versioned collaboration ledger and report health. This implements the foundation described by the PRD's architecture, storage, rollout, and code-structure sections without prematurely building later phases.

## Ground Truth

- An operator starts the headless service and sees an explicit healthy state without opening Electron.
- Restarting the service preserves the collaboration storage version and does not recreate or lose its state.
- A maintainer can identify the exact OpenMausBot baseline and distinguish the project repository from its upstream source.
- A reader of the PRD can clearly tell which capabilities belong to the first milestone and which are deferred.

## 完成信号

- [x] A clean environment can install dependencies, start the headless service, and observe a healthy result.
- [x] Starting the service twice against the same storage does not duplicate schema state.
- [x] The recorded source history contains baseline `7417725` and does not configure the upstream repository as the project's push destination.
- [x] Automated validation confirms the first-milestone configuration excludes deferred execution capabilities by default.

## Completion evidence

- `server/collaboration/db.test.ts` verifies private SQLite creation, WAL/foreign-key safety, schema version 1, restart idempotency, preserved metadata, and migration tamper rejection.
- `server/collaboration/service.test.ts` verifies deterministic Headless health, the one-shot probe, and fail-closed first-milestone defaults.
- `node --experimental-strip-types server/collaboration-headless.ts --health --data-dir <temporary-dir>` returned `status=healthy`, schema version 1, one applied migration, and `executionMode=observe`.
- Git contains commit `741772505499a6c72ba462dec635966f39737914`; the only named source remote is `upstream`, with no `origin`, `remote.pushDefault`, or branch push remote configured.

## User stories addressed

- Foundation: Run the collaboration control plane independently of the desktop lifecycle.
- E2E-10: Preserve recoverable state across a service restart.

## Background hints

Keep the collaboration domain and database isolated from transcript storage while reusing the existing runtime through narrow adapters.
