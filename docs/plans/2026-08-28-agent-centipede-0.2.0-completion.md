# Agent Centipede 0.2.0 completion execution map

This is a repository execution map and promotion receipt index. It is not a current-work board. Until promotion, Chief's `MEMORY.md` `## Live locks` remains the only current-work board and Grok Bot plus the old Capture path remain live.

## Contract

Objective: finish the substrate in one coordinated pass, produce a local 0.2.0 release candidate, and prove it through the complete promotion gate.

Success: every row below has an implementation reference and independently checkable proof in `artifacts/centipede-0.2.0/`; state survives a 0.1.96 upgrade; no ambiguous write replays; Android 0.2.0 passes the S26 Ultra matrix; the two-hour injected-failure run completes; public artifacts pass privacy and secret scans.

Not success: compiling alone, unit tests alone, a builder checking its own work, a successful provider/installer exit without a user journey, a second current-work board, a second orchestration path, or promotion before Shane's final gate.

Source of truth: this checkout is the source tree matching the installed 0.1.96 desktop build (`package.json`, `electron-builder.yml`, and installed `app-update.yml`). Durable product state is the existing local data directory. Chief's Live locks remain operational truth until the verified Work projection is promoted one way.

External boundaries: no send, spend, deploy, publish, release, delete, signing, OAuth change, production change, external permission change, or ambiguous mutation replay. Provider mutations and failure injection use local fakes. Shane's hands are reserved for S26 unlock/permissions, exact Chrome-tab approval, unavoidable OAuth, and a commercial Windows signing certificate.

The charter pre-agrees one public test seam: `WorkOrchestrator` with `ingest(event)`, `prepare(workId)`, `decide(approval)`, `execute(workId)`, and `reconcile(workId)`. Tests and production callers cross that seam. Existing stores and provider adapters become implementation details; no sibling orchestrator will be added.

## Dependency order and slice map

| # | Required slice | Current implementation | Completion move | Promotion proof |
|---|---|---|---|---|
| 1 | Canonical work | `server/work-lock-store.ts` has durable obligations, approvals, deadlines, evidence, optimistic versions, and open projection. Routes and routine sync call it directly. Production store has not been populated from Chief. | Put all new work ingestion behind `WorkOrchestrator`; add a one-way, dry-run-first profile importer for approved Live locks; do not write Chief memory. | Import fixture is deterministic and idempotent; Work projection contains obligations/approvals/deadlines/guards once; no duplicate board is emitted. |
| 2 | Permissions | `ActionPolicy` binds exact operation/account/payload hashes, supports revocation and one-time authorization. `canonical-connector-action.ts` covers Gmail/Calendar/Drive/GitHub; the live internal route coordinates only canonical connected-app calls and special-cases Gmail draft UI. Summary-only engine approvals remain outside exact policy. | Make the orchestrator own canonicalization, proposal creation, durable approval, one-time consumption, execution state, and reconciliation. Route connector mutations through it first; add browser/computer adapters before promotion. Unknown mutations fail closed. | Exact Gmail-draft payload succeeds once in a fake; byte change and wrong account fail; revoked approval fails; second execution and restart never call the fake. |
| 3 | Accounts | `AccountDirectory` is owner-scoped, durable, provenance-only, and ambiguity-safe. Registration and resolution routes exist. Current production snapshot is empty. | Add explicit inventory adapters for connected apps, browser profile approvals, phone, and local profile import. Bind arbitrary logical identities from an importable profile; never infer by display name. | Personal/SEF/Anvil fixture resolves exactly from each source; conflicting candidates return `ambiguous`; wrong exact account is rejected. Production population waits for safe source reads/Chrome approval. |
| 4 | Capture | `CaptureLedger` owns cursors/receipts; `CaptureSupervisor` is resident, restart-safe, coalesces wakeups, prefilters unchanged markers, and retries only an explicitly safe changed strategy. Startup disables matching legacy polling after supervisor creation. | Feed changed action evidence into `WorkOrchestrator.ingest`; keep legacy schedule and outbox available through independent verification. Consolidate source rules into the bundled Capture skill and product catalog. Add push/local wake adapters where credentials exist. | Unchanged marker skips; changed marker wakes once; duplicate evidence dedupes; restart during an attempt does not replay; legacy path remains executable. |
| 5 | Execution | `worker-jobs.ts` already creates hidden task-scoped workers with queued/running/terminal projections, safe-only recovery, concurrency cap, and durable file store. Permanent named Exec bots still exist as user topology. | Have orchestrator execution request task-scoped work through the existing worker module. Product behavior must not require a named Exec; imported profiles may still contain one. | Worker exists only for its task; inline projection progresses queued→running→verified; process restart resumes safe reads only and reports ambiguous work without replay. |
| 6 | Continuity | Worker recovery, Capture recovery, updater/restart coordinator, checkpoints, SQLite WAL stores, and state-preserving installer behavior exist independently. There is no durable cross-store action phase. | Add orchestrator operation journal with pre-execution persistence and terminal reconciliation. Treat a recovered `executing` mutation as ambiguous and blocked. Checkpoint orchestrator before updater handoff. | Restart during read, worker, and pending approval preserves state; restart at mutation boundary produces `replay_prevented`; no fake executor second call. |
| 7 | Performance | `TaskPerformanceTracker/Ledger`, context budget/rebuild, turn prefilter, session reuse summary, and Chief prewarm exist. `AutonomyTelemetry` is durable but has no production events. | Record work/approval/verification events inside the orchestrator; add warm/cold benchmark receipts and truthful usage source labels. | 30-minute warm run, Chief prewarm, compaction/prefilter checks, and warm/cold median latency comparison with raw samples. |
| 8 | Desktop UX | Chat is primary. `WorkView`, contextual worker cards, approvals, receipts, computer view, Settings, and More exist, but the full simplicity journey has not been independently qualified. | Expose only orchestrator projections; keep bindings/policies/diagnostics/recovery under contextual detail or Advanced. Remove any duplicate cockpit/board discovered by journey QA. | Independent Windows journey screenshots at desktop and ~390px equivalent; chat remains primary and only contextual active-work/approval/receipt/computer/Work/More appear. |
| 9 | Android | Android sources are already version 0.2.0 (code 200) with FCM, notification deep links, biometric approval gate, WorkManager notification-mirror queue/heartbeat, reconnect, and computer screenshot view. Physical 0.1.84→0.2.0 proof is absent. | Keep the APK local and unsigned-by-distribution. Run unit/assemble checks, then install only at Shane's physical-action gate and preserve pairing/state. | S26 Ultra: closed-app push, correct deep link, biometric approval, offline queue drain, background reconnect, notification mirror, computer view, and state-preserving upgrade screenshots. |
| 10 | Capture sources | Ledger/catalog/cadence, browser extension, Plaud/local/notification adapters, Gmail/Calendar/Drive connected apps, GitHub, Anvil BI/Mercury, and browser receipts exist in separate modules. Live credentials and freshness vary. | Route source receipts through one source contract with provenance, freshness, dedupe, and fail-closed auth; use content-free health reads until final auth/tab gate. | Per-source receipts for Plaud, Messages, Gmail/Calendar/Drive, GitHub, Anvil BI/Mercury, and approved browser sources show provenance/freshness/dedupe; missing auth is an explicit failure. |
| 11 | Recovery | `electron/encrypted-backup.mjs` creates authenticated encrypted backups, verifies SQLite bytes, applies bounded retention, and has unit tests/UI controls. A full offline restore wizard and rollback drill are not proven. | Add offline restore/rollback command path that validates into a temporary root before atomic replacement; never restore while the live server owns files. | Automated backup→corrupt live copy→offline restore→integrity check→rollback drill, plus retention proof. |
| 12 | Distribution | Desktop is 0.1.96, Android source is 0.2.0. Windows NSIS/zip packaging and public updater metadata exist; Windows is intentionally unsigned. `electron-builder.yml` packages an Android release APK. | Bump desktop to 0.2.0 only after safe gates, build a local RC, and test upgrade. Do not sign/upload/host/copy to Drive/release without exact approval and certificate. | Fresh install and 0.1.96 upgrade preserve state. Local artifact hashes recorded. Signing/hosted download/Drive copy remain explicit final blockers until approved. |
| 13 | Benchmarks | `benchmarks/agent-centipede` supplies topologies, scenarios, sandbox, trace, scoring, and live/fake adapters; browser and Windows CUA exist. | Add orchestrator safety scenarios, a throwaway product-build scenario, independent verifier role, visual QA, and two-hour injected-failure runner. | Browser guest verification, Windows screenshot journey, tested throwaway build with visual QA, and two-hour auth/provider/network/restart failure run. |
| 14 | Migration | Grok corpus importer exists; current operational truth remains Chief Live locks and Grok Bot. | Provide a one-way dry-run import profile and receipt. Do not activate authority or bidirectional sync. | Useful history imports once into a disposable store; second import dedupes; live Grok and Capture remain unchanged. Promotion requires Shane. |
| 15 | Product generality | Bot/team/package models are mostly generic, but account labels, benchmark topology, Capture routine assumptions, and Gmail-only approval presentation carry Shane-specific defaults. | Move Shane topology into an importable profile/fixture. Use generic identities, agents, routines, models, and permission sets in product code. | A non-Shane fixture with different names/providers/topology passes the same orchestrator and UI journeys. |

## Promotion-gate receipt index

Every evidence item must name the command or journey, UTC start/end, exit state, input fixture or state snapshot, and artifact hash where applicable. Builder output does not count as verifier evidence.

| Gate | Required receipt |
|---|---|
| Fresh install and 0.1.96 upgrade | `artifacts/centipede-0.2.0/distribution/upgrade-state.json` plus before/after screenshots and state hashes |
| Desktop restart during reads, workers, pending approval | `continuity/restart-matrix.json` |
| No replay of send/spend/publish | `orchestrator/no-replay.junit.xml` and fake executor call ledger |
| Gmail Draft exact payload | `orchestrator/gmail-draft-exact.json`; local fake only until exact external approval |
| Wrong account rejection | `orchestrator/wrong-account.json` |
| Capture unchanged/changed/dedupe | `capture/supervisor-matrix.json` |
| Browser workflow + guest verification | `journeys/browser/` screenshots, trace, and guest-verifier verdict |
| Windows workflow | `journeys/windows/` screenshots and semantic postconditions |
| Throwaway product build | `benchmarks/product-build/` source hash, checks, screenshots, independent verdict |
| S26 Ultra matrix | `journeys/android-s26/` screenshots and per-capability results |
| Two-hour unattended failures | `benchmarks/unattended-2h/events.ndjson` and summary |
| Privacy/secret scan | `privacy/public-artifact-scan.json` with scanner versions and allow-list |

## Implementation checkpoints

1. Red: tests at the `WorkOrchestrator` seam for exact account/payload, approval once, restart/no replay, independent verification, Capture dedupe, and telemetry. Green: minimal orchestration journal and calls into existing stores/adapters.
2. Replace the live canonical connector coordination with the orchestrator; preserve the old Capture and Grok paths.
3. Add explicit account/source/profile import adapters and one-way dry runs.
4. Complete recovery, generality, UX, and benchmark gaps.
5. Run local full checks and independent desktop/browser/product journeys.
6. Run the two-hour failure matrix.
7. Stop at Shane's batched physical/auth/signing gate; after those actions, run S26 and upgrade matrices. Promotion/release remains a separate exact approval.
