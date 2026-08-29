# Agent Centipede V3 completion receipt — 2026-08-28

## Result

V3’s production server path is implemented and independently verified through the public Outcome dispatch seam, the real V2 WorkOrchestrator ingest/prepare/decide/execute/reconcile seam, durable WorkLock, WorkerJobs, independent reconciliation, trace/receipt learning feedback, and the packaged server entry point. The desktop shell and repository-wide lint still have explicit blockers below, so this receipt does not call the prototype fully ready or promoted.

## Scope and isolation

- Worktree: `C:\Users\shane\Documents\Codex\2026-08-26\give\worktrees\OpenMausBot-v3`
- Branch: `codex/v3-outcome-mode`
- Base/source commit: `667af71ae7e93640ba4b1a5f3b38a1ad342025da`
- Live V2 checkout was read-only inspected at `C:\Users\shane\Documents\Codex\2026-08-26\give\work\OpenMausBot`; it was not edited.
- V3 keeps its own product/app identity, ports, data root, WorkLock DB, worker journal, protocol, and package output. No install, deploy, publish, upload, promotion, merge, or V2 replacement occurred.

## Implemented

- `server/outcome-orchestrator.ts`: strict Zod command/event/contract boundaries; provenance-bearing Capture context deltas; graph-relative inference and conflict handling; canonical Work linking/dedupe; exact green/yellow/red judgment; fail-closed replay; complete trace identity; independent verification and receipts.
- `server/centipede-v3-runtime.ts`: production V3 wiring to the real V2 WorkLock, WorkOrchestrator, WorkerJobs, worker receipt, action-policy, account, telemetry, verifier, context graph, and bounded learning stores.
- `server/work-lock-store.ts`, `server/work-orchestrator.ts`, `server/worker-jobs.ts`, `server/worker-job-file-store.ts`, `server/worker-batch-receipt.ts`, and related V2 adapters: retained the locked external ingest/prepare/decide/execute/reconcile interface.
- `server/centipede-v3-runtime.test.ts` and `server/outcome-orchestrator.test.ts`: red-first public-seam coverage for success, duplicate Capture, graph conflict/ambiguity, yellow/red gates, authority/deadline/budget refusal, worker delay/failure paths, forged verification refusal, corrupt journal, replay, context feedback, trace completeness, and exact-once execution.
- `scripts/smoke-v3-coexistence.mjs`: starts real V2 and V3 server entries concurrently and checks distinct PIDs, identities, endpoints, data roots, and V3 WorkLock placement.
- `electron/centipede-v3-identity.*`, `electron-builder.v3.yml`, and existing V3 main/runtime changes: distinct desktop/app/protocol/package identity and V3 server routing.

## Verification evidence

| Check | Result | Evidence |
|---|---|---|
| Focused V3 seams | passed | `vitest run server/centipede-v3-runtime.test.ts server/outcome-orchestrator.test.ts server/execution-learning.test.ts` — 3 files, 17 tests passed |
| Full test floor | passed | `pnpm test` — 2,088 counted; 2,002 passed; 86 skipped; floor 1,070; broker/updater/viewer/package-link/save-file/packaged-server checks passed |
| Client + server typecheck | passed | `pnpm typecheck` |
| Production client build | passed | `pnpm build` — 2,578 modules transformed |
| Server bundle | passed | `pnpm build:server` — `dist-server/v3-index.js` 1.9 MB |
| Packaged server journey | passed | `pnpm test:packaged-v3-server` — V3 health 200, context 200, Capture 200, verify 200, completed outcome |
| Fresh unpacked package journey | passed | `OMB_SMOKE_DIST=release-v3/win-unpacked/resources/server node scripts/smoke-packaged-v3-server.mjs` — health/Capture/verify all passed |
| V2/V3 coexistence | passed | `pnpm test:v3-coexistence` — simultaneous `openmausbot` and `Centipede V3`, distinct PIDs 36444/8292 in the first green run, distinct ports/data roots, V3 WorkLock isolated |
| V3 identity/deep links | passed | `node --test electron/centipede-v3-identity.node-test.mjs electron/package-link.node-test.mjs` — 3 passed |
| Electron static check | passed | `pnpm check:electron` — 64 modules syntax-checked |
| Strict touched/new-file lint | passed | `oxlint` over all V3 implementation, tests, smoke, identity, and copied V2 seam files — exit 0 |
| Diff integrity | passed | `git diff --check` — exit 0; only normal LF→CRLF warnings |
| Secret/private artifact scan | passed | scoped scan found no high-confidence credential markers in touched/new V3 artifacts |

## Package artifacts

- Setup: `C:\Users\shane\Documents\Codex\2026-08-26\give\worktrees\OpenMausBot-v3\release-v3\Centipede-V3-0.1.37-setup.exe`
- Zip: `C:\Users\shane\Documents\Codex\2026-08-26\give\worktrees\OpenMausBot-v3\release-v3\Centipede-V3-0.1.37-x64.zip`
- Requested copied setup: `C:\Users\shane\.openmausbot\workspaces\3df4d235-3dfc-4b20-a140-75ee2abb8875\outputs\Agent Centipede V3\Centipede-V3-0.1.37-setup.exe`
- Setup SHA-256: `538F0C8E12E8F0D86F622CEB8CC9EE578C6ECA125DF14F981FB9B01AFF90FD27`
- Copied setup SHA-256: same; source/destination bytes `122,983,015`
- Zip SHA-256: `0FC40B38AEC32A5200B6D50B5D209D761C4B2A734437364053FE99CBDC2567E1`
- Unpacked executable SHA-256: `B053621764B47F189D9799517B3FDEB9893E19D879D85B3D551061AEE60219EC`
- Packaged `v3-index.js` SHA-256: `98630BFB3CBE6C751D8EC5F7720E56624D9F3526EC50A5EC93890002BE3909F1`

## Remaining blockers

1. The unpacked Electron shell was launched twice through direct process startup. Its V3 server child began on port 18899 and wrote the V3-only `logs/server.log`, but the desktop process exited before the health probe returned. A CUA foreground/window journey was not run because the Computer Use policy requires an action-time confirmation to run newly built software. Smallest next human action: approve that visible desktop launch, then verify the one V3 window and Capture → verify journey.
2. `pnpm lint` remains red on the repository’s inherited anti-slop backlog in untouched legacy files and generated `release-v3` JavaScript. The complete touched/new V3 file lint set passes; no V3 lint failure remains.
3. The V3 packaged runtime uses the real durable V2 WorkerJobs/WorkOrchestrator path, with the standalone bounded worker runner as its default provider adapter. A live provider/model turn runner remains an external integration choice; no provider credential or external action was assumed.

## Approval boundary

The package is rebuilt and copied, but not installed, launched for normal use, deployed, published, uploaded, promoted, or used to replace V2. V3 remains an isolated candidate pending the desktop action-time check, the inherited lint cleanup decision, and explicit promotion approval.
