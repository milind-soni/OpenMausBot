---
status: done
created: 2026-08-15
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: per-instance agent permission toggle
owner: claude
related: [docs/dev/plans/implementation--agent-permission-toggle.md]
---

# Let the user set agent auto-approve permission from Settings

Add a per-instance "Ask before actions" / "Full auto" toggle to Settings → Models, backed by a new write path for `instances.<id>.config`. Full design in `docs/dev/plans/implementation--agent-permission-toggle.md` (approved 2026-08-15). Does not cover per-task/per-project overrides.

---

## 1. Driver contract

- [x] **Add `getAutoApprove`/`setAutoApprove` to `ProviderDriver<C>`** — `server/contracts.ts:193-201`. Optional accessors so drivers without a permission concept opt out cleanly.
- [x] **Implement both in `claude.ts`** — `server/drivers/claude.ts:202-210`. Maps `permissionMode` ↔ boolean (`"auto"` alias folds into `false`).
- [x] **Implement both in `codex.ts`, `antigravity.ts`, `acp/core.ts`** — direct passthrough on `fullAuto`.

## 2. Registry + API read path

- [x] **Retain decoded config on `RegistryEntry`** — `server/harness/registry.ts:23-25,60`. Added `getDriverConfig()` for the write path too.
- [x] **Expose `autoApprove: boolean | null` from `describe()`** — `server/harness/registry.ts:89-123`.
- [x] **Add `autoApprove` to `InstanceInfo`** — `src/state/store.tsx:146-158`.

## 3. Write path

- [x] **Extend `saveConfig` to merge an `instances` patch** — `server/config.ts:56-77`.
- [x] **Add `PATCH /api/instances/:instanceId`** — `server/index.ts:1468-1491`. Reuses `reloadProviders()`; also wired an `instances` SSE broadcast case client-side (`src/state/store.tsx`) so other open windows/tabs pick up the change.

## 4. UI

- [x] **Add the toggle to `ModelsSection`** — `src/components/SettingsScreen.tsx`. Hidden when `autoApprove === null`; disabled + spinner while a reload is in flight; inline error on failure.

## 5. Tests

- [x] **Driver-level `getAutoApprove`/`setAutoApprove` round-trip tests** for all four drivers — `server/drivers/claude.test.ts`, `codex.test.ts`, `antigravity.test.ts`, `acp/acp.test.ts`.
- [x] **`saveConfig` merge test** — `server/config.test.ts` (new file): new entry, merge without clobbering siblings, other instances untouched, other top-level config keys untouched.
- [x] **Integration test for `PATCH /api/instances/:id`** — `server/instances-permission.test.ts` (new file), boots the real server against a fake-CLI-backed Claude instance: happy path + disk persistence + reload, 400 on bad body, 404 on unknown/shadow instance.
- [x] **`pnpm typecheck`, `pnpm test`, `pnpm build`** all pass (233/233 tests).

## Manual verification

Verified end-to-end against a real (non-mocked) local fleet on an isolated scratch `GBS_DATA_DIR`/port, not the user's live dev server: `GET /api/instances` reports `autoApprove`; `PATCH /api/instances/claude {"autoApprove":true}` returns the updated snapshot and persists `permissionMode: "bypassPermissions"` to disk. Browser-based UI click-through was not completed — the Chrome extension used for browser automation disconnected mid-session. UI code was typechecked, built, and code-reviewed against the existing `ApiKeys.tsx`/`SettingsPanel.tsx` toggle patterns it reuses.
