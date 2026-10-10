# Local Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desktop users can create, switch, and forget named local environments (separate data directories = separate bots/providers/settings), one active at a time, switching via a ~15s in-app server restart.

**Architecture:** Environments are directories; isolation already exists end-to-end via `OMB_DATA_DIR` (`server/config.ts:963`). All work is Electron-side: extend the pure registry module `electron/environments.cjs` with versioned local entries, add an injectable-deps switch orchestrator `electron/environment-switch.mjs`, wire it in `electron/main.mjs` (per-environment data-dir lease handoff + child re-fork), and expose it through the existing `ogb.environments` bridge to the existing switcher/settings screens. The server binary is NOT modified.

**Tech Stack:** Electron (CJS + .mjs, `node:test` via `node --test "electron/*.node-test.mjs"`), React 19 + vitest, flat dotted `en.json` copy.

**Spec:** `docs/superpowers/specs/2026-10-07-local-environments-design.md`

## Global Constraints

- User-facing copy never says "workspace"/"Organisation" (`src/locales/words.test.ts`); the feature word is "environment(s)"; one running app is an "installation"; a bot's dir is a "folder".
- No changes under `server/`, `src/locales/zh.json`, or any lockfile. New copy is hardcoded English inside the settings component ONLY if that file already hardcodes English (it does — keep its style); no new `en.json` keys required.
- Local-environment switching is packaged-only (`app.isPackaged`); in dev mode create/switch IPC returns `{ ok: false, error: "dev" }`.
- `activeId` for a local environment persists only after the health probe returns `"ready"`.
- Default data dir `~/.openmausbot` stays "This computer": never listable as an entry, never forgettable, boot fallback target.
- Conventional commits; `pnpm lint` (`oxlint --deny-warnings .`) and `pnpm typecheck` clean at every commit.

## Review Focus

1. Unmounted target volume (data dir on external drive) → switch aborts, old environment keeps running, `activeId` unchanged.
2. Target lease held by another app process → switch aborts, old environment keeps running.
3. App boots into an environment whose server never becomes healthy → automatic one-time fallback to "This computer" (files untouched).
4. Switch while turns are in flight → child gets the normal graceful stop (`stopUtilityServer`), no double-start by the supervisor backoff.
5. A `version: 1` `environments.json` (no `kind` fields) → parses as all-remote, active unchanged, later serialize upgrades to `version: 2`.

---

### Task 1: Versioned environment registry (`electron/environments.cjs`)

**Files:**
- Modify: `electron/environments.cjs` (210 lines, pure)
- Test: `electron/environments.node-test.mjs`

**Interfaces:**
- Consumes: existing `parseEnvironments(raw)`, `serializeEnvironments(state)`, `withActive(state,id)`, `withoutEnvironment(state,id)`, `workspaceMenuTemplate(state,{onSwitch,onConnect,onForget})`, `LOCAL_ID`, `MAX_NAME` (60).
- Produces (used by Tasks 2–4):
  - entries gain `kind`: remotes are `{ id, kind:"remote", name, origin }`; locals are `{ id, kind:"local", name, dataDir }`.
  - `parseEnvironments(raw)` — accepts version 1 or 2; stamps `kind:"remote"` on entries with an origin and no kind; keeps locals with an absolute `dataDir`; drops locals whose path is relative; damaged → `{ environments: [], activeId: LOCAL_ID }`.
  - `serializeEnvironments(state)` — writes `version: 2`.
  - `withLocalEnvironment(state, { name, dataDir }, makeId) → { ok: true, state } | { ok: false, error }` — errors `"name"`, `"path"`, `"duplicate"`, `"nested"`; nested = `dataDir` equals or is inside any registered env's `dataDir` or the passed `defaultDir` (prefix compare on trailing-`/` paths); `defaultDir` arrives as fourth arg.
  - `activeLocalDataDir(state, defaultDir) → string | null` — `dataDir` when `activeEnvironment(state)` is `kind:"local"`, else `null`.
  - `workspaceSummary(state)` returns `{ local:true, name:"This computer" }` or `{ local:false, name, origin, localPath?: string, missing?: boolean }` — for a local active entry `local:false` is wrong; instead extend the local branch: `{ local: true, name: entry.name, localPath, missing }`.
  - `workspaceMenuTemplate` — one radio row per local entry (same `onSwitch(id)` callback), "This computer" row always first.

- [ ] **Step 1: Write failing tests** in `electron/environments.node-test.mjs` (follow existing `const env = require("./environments.cjs")` style): `parseEnvironments` on a v1 JSON string stamps `kind:"remote"` and preserves `activeId`; `serializeEnvironments` output has `version: 2`; `withLocalEnvironment` happy path adds `{ id: <makeId()>, kind:"local", ... }`; rejects non-absolute `dataDir`, `dataDir === defaultDir`, nesting (`~/.openmausbot/x` under default `~/.openmausbot`), duplicate path, name length > 60; `activeLocalDataDir` returns the entry's dir when active-local, `null` for `LOCAL_ID`/remote; `workspaceMenuTemplate` renders a row per local entry calling `onSwitch` with the entry id.
- [ ] **Step 2: Run to verify failure** — `pnpm test:electron` → new cases fail (Review Focus 5 first case here).
- [ ] **Step 3: Implement** in `environments.cjs` (signatures above; keep the file dependency-free).
- [ ] **Step 4: Run to verify pass** — `pnpm test:electron` fully green.
- [ ] **Step 5: Commit** — `git add electron/environments.cjs electron/environments.node-test.mjs && git commit -m "feat(electron): versioned local entries in the environments registry"`

### Task 2: Switch orchestrator (`electron/environment-switch.mjs`)

**Files:**
- Create: `electron/environment-switch.mjs`
- Create: `electron/environment-switch.node-test.mjs`

**Interfaces:**
- Consumes: `DataDirLeaseError` from `./data-dir-lease.mjs`.
- Produces (Task 3):
  - `validateTargetDir(dataDir, fsImpl = fs) → { ok: true, needsCreate: boolean } | { ok: false, error: "unavailable" }` — `ok:false` when `path.dirname(dataDir)` does not exist; `needsCreate:true` when `dataDir` itself is absent.
  - `switchLocalEnvironment({ targetDir, deps }) → Promise<{ ok: true } | { ok: false, error, rolledBack: true }>` with
    `deps = { stopChild, releaseLease, acquireLease, createDir, startChild(port), probeReady(port, pid), rollback(port), persistActive(id), log }` — order per spec §Switch flow: `stopChild` → `releaseLease` → `validateTargetDir` (then `createDir` when `needsCreate`) → `acquireLease(targetDir)` → `startChild` → `probeReady`; any failure after `releaseLease` → reacquire old lease inside `rollback(port)` and resolve `{ ok:false, rolledBack:true }` with `persistActive` NOT called; success calls `persistActive` last. Lease acquisition failure surfaces `error: "locked"`; validation failure `error: "unavailable"`.

- [ ] **Step 1: Write failing tests** with hand-rolled fake deps recording call order — happy path order `["stop","release","acquire","start","probe","persist"]`; missing parent dir → child restarted via `rollback(8799)`, no persist, `error:"unavailable"` (Review Focus 1); `acquireLease` throws `DataDirLeaseError` → `error:"locked"`, old lease reacquired, no persist (Review Focus 2); `needsCreate` target → `createDir` called before `acquire`; `probeReady` returns `"exited"` → rollback, no persist (Review Focus 4's double-start guard: assert `startChild` called exactly twice total across a failed-then-rolled-back switch and `stopChild` exactly once).
- [ ] **Step 2: Run to verify failure** — `pnpm test:electron`.
- [ ] **Step 3: Implement** (plain ESM module, no Electron imports — all IO through `deps`/`fsImpl`).
- [ ] **Step 4: Run to verify pass** — `pnpm test:electron`.
- [ ] **Step 5: Commit** — `feat(electron): injectable local-environment switch orchestrator`

### Task 3: main.mjs wiring — boot, supervisor pause, IPC

**Files:**
- Modify: `electron/main.mjs` (`desktopDataDir` :370, `startServerOn` :1305, lease block :3368–3384, `switchEnvironment` :1918, IPC :3197–3210, `readEnvironments` :1847)
- Modify: `electron/server-supervisor.mjs` (add `pause()`/`resume()` gating `schedule()`)
- Test: extend `electron/server-supervisor.node-test.mjs` (extend if present, else create following sibling `*.node-test.mjs` style)

**Interfaces:**
- Consumes: Task 1 `activeLocalDataDir`, `parseEnvironments`; Task 2 `switchLocalEnvironment`, `validateTargetDir`; existing `acquireDataDirLease(dataDir, opts)`, `stopUtilityServer(proc)` (:378), `pollServerIdentity({port,pid})`, `persistEnvironments`, `startServerPackaged` port list `[8799,18799,28799]`.
- Produces (Task 4 IPC payloads): `environments:state` now also returns `packaged: boolean` and each entry `{ id, kind, name, origin?, dataDir?, missing }` (`missing` = local whose `dataDir` is absent at read time); `environments:create(name, dataDir?) → { ok, error?, state }`; `environments:pick-dir → { ok, path? }` via `dialog.showOpenDialog({ properties: ["openDirectory","createDirectory"] })`; `environments:switch(id)` returns `{ ok, error? }` for local targets, unchanged for remote; `environments:forget(id, purge?)` — `purge:true` additionally `fs.rm(dir, {recursive:true})` only when `path.basename(dir).startsWith(".openmausbot")` and dir is outside the app's own default dir.

- [ ] **Step 1: Supervisor pause test** — while paused, a tracked child exit schedules no restart; `resume()` re-arms. Verify failure, then implement pause/resume, verify pass.
- [ ] **Step 2: Boot-environment selection** — extract pure `startupEnvironmentDir(environmentsState, defaultDir)` into `environments.cjs` (`activeLocalDataDir(state, defaultDir) ?? defaultDir`); wire `whenReady`: read environments BEFORE the lease block (:3368), lease + child env (`OMB_DATA_DIR`) both use the selected dir; dev mode keeps today's behavior untouched.
- [ ] **Step 3: Boot fallback (Review Focus 3)** — when `startServerPackaged()` fails and the boot dir is a named environment: `persistEnvironments({ ...state, activeId: LOCAL_ID })`, release that lease, acquire the default-dir lease, retry once, `dialog.showErrorBox` noting the environment was unhealthy.
- [ ] **Step 4: Switch wiring** — `switchEnvironment(id)`: when the entry is `kind:"local"`, pause supervisor, call `switchLocalEnvironment` with real deps (startServerOn gains `dataDir` second param defaulting to `desktopDataDir()`; env spread replaces the `OMB_DATA_DIR` line :1336), reload the window to `rendererOrigin()`, resume supervisor; return the orchestrator result through the existing `environments:switch` handler.
- [ ] **Step 5: Create/pick/forget IPC** (payloads in Interfaces; register next to :3203 inside `localOnly(workspaceOnly(...))`); create validates through `withLocalEnvironment` with `defaultDir = desktopDataDir()`; when `dataDir` is omitted, default to `path.join(os.homedir(), ".openmausbot-" + slug)` where `slug` = `name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")` (reject error `"name"` if the slug is empty).
- [ ] **Step 6: Verify** — `pnpm typecheck && pnpm test:electron && pnpm lint` green.
- [ ] **Step 7: Commit** — `feat(electron): switch the server child between local environment data dirs`

### Task 4: Bridge + settings UI

**Files:**
- Modify: `electron/preload.cjs` (bridge :305–317), `src/types/ogb.d.ts` (:145–157), `src/components/ConnectedWorkspacesSettings.tsx`, `src/components/ConnectedWorkspacesSettings.test.ts`

**Interfaces:**
- Consumes: Task 3 IPC shapes exactly.
- Produces: bridge methods `create(name, dataDir?)`, `pickDir()`; `switch(id)` result now checked by callers; new section title "Environments on this computer" above the existing "Your servers" list; "New environment" form (name field, path field + "Choose…" + Create) shown only when `state.packaged`; local rows show `name` + `dataDir` (+ "missing" tag) and a Forget button.

- [ ] **Step 1: Write failing renderer tests** — stub `window.ogb.environments` (state with one local entry, `packaged:true`); assert the local row renders its `dataDir`, a missing entry shows "missing", Create calls `create(name, dir)`, Forget shows the keep-files choice and only passes `purge:true` when checked, and switching a local row calls `switch(id)` after confirm.
- [ ] **Step 2: Run to verify failure** — `pnpm vitest run src/components/ConnectedWorkspacesSettings.test.ts`.
- [ ] **Step 3: Implement** preload channel additions + `ogb.d.ts` types (keep `REMOTE_SAFE` exposure unchanged: `environments` stays local-only).
- [ ] **Step 4: Implement UI** in `ConnectedWorkspacesSettings.tsx` following its existing `perform()` pattern.
- [ ] **Step 5: Run to verify pass** — `pnpm vitest run src/components/ConnectedWorkspacesSettings.test.ts`.
- [ ] **Step 6: Commit** — `feat(ui): manage local environments from settings`

### Task 5: Docs trio + full local gate

**Files:**
- Create: `docs/plans/local-environments.md` (short plan summary mirroring the spec)
- Create: `docs/verification/local-environments.md` (manual recipe: create env → switch (watch ~15s reload) → verify empty bot list + separate `environment-id` → unplug-drive abort case → fallback case)
- Modify: none (spec already committed)

- [ ] **Step 1: Write both docs** per `CONTRIBUTING.md` conventions.
- [ ] **Step 2: Full gate** — `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm test:electron`, `pnpm i18n:check`; all green.
- [ ] **Step 3: Commit** — `docs: local environments plan and verification recipe`

## Self-review notes

Spec coverage: isolation/switch/fallback (T2–T3), registry+migration (T1), create/forget UX (T3–T4), docs (T5); copy-from-current is a non-goal (spec) — no task. Type consistency checked across Interfaces blocks. No `en.json` delta → `words.test.ts` unaffected. One deliberate spec deviation: the spec's `launchVerificationServer` two-dir boot test is dropped — this plan changes zero server files, so the server already carries that coverage and adding `server/` test files would violate the no-server-changes constraint; if maintainers want it, it is a pure addition they can pin in review.
