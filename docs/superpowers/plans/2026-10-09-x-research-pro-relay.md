# X Research for Cloud Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Each task is test-first (superpowers:test-driven-development). Omkar asked for one pass; this plan names files, interfaces and tests rather than listing full code.

**Goal:** X research becomes an included service of paid OpenMausBot Cloud plans: an Admin relay with per-tier monthly allowances, tokens for Cloud homes and signed-in desktops, and no bring-your-own token.

**Spec:** `docs/superpowers/specs/2026-10-09-x-research-pro-relay-design.md`

**Worktrees:** app `/Users/omkar/Desktop/openmaus/OpenGrokBot-x-research` (branch `feat/x-research-pro`, from local main a5406ed2); Admin `/Users/omkar/Desktop/openmaus/openmaus-cloud-x-relay` (branch `feat/x-research-relay`, from origin/main 82f1386). Node 24. Nothing is pushed or deployed.

## Global Constraints

- Admin rules (openmaus-cloud AGENTS.md): schema only through `migrate()`, additive and idempotent; no edits to applied migrations or `runtime/`; tests never make paid calls; expected errors are a status and a plain sentence; never log bodies, tokens or emails.
- Relay endpoint allow-list is exactly the eight ids in the spec.
- Allowances: personal 1,500, pro 5,000, max 15,000 per account per UTC month; unknown plan `OMB_CLOUD_X_CALLS_PER_MONTH` (default 1,500).
- Token prefixes: home `omb_x_`, desktop `omb_xd_`. Env: `OMB_CLOUD_TREG_KEY` (Admin), `OMB_CLOUD_X_URL` + secret `OMB_CLOUD_X_TOKEN` (homes).
- App parent-port message: `{ type: "openmausbot:included-x", access: { url, token } | null }`.
- The included token is never written to config.json, never reported to a client, never in an engine's environment.

## Review Focus

1. A desktop whose Cloud plan lapses mid-session must be refused by the relay on the next call (402), whatever the app still holds.
2. A signed-out or expired desktop sign-in must stop its relay token at once.
3. Concurrent calls at the allowance edge must not pass the cap.
4. Treg refusing our key must read as "temporarily unavailable" to the customer, never as their plan or token problem.
5. Removing the person's token must not break loading an existing config.json that still contains `treg`.

## Admin tasks (openmaus-cloud)

### Task C1: Tier allowance `xCallsPerMonth`
- Files: `server/cloud-plans.ts`, `tests/cloud-plans.test.ts` (or the existing tier tests).
- Add `xCallsPerMonth: count(10_000_000)` to the tier numbers, the override shape, and the defaults (1,500 / 5,000 / 15,000). Pro takes 5,000 directly.
- Tests: the defaults per tier; an `OMB_CLOUD_TIERS` override of one tier's `xCallsPerMonth`; an out-of-range value refused with a sentence naming the variable.

### Task C2: X relay, allowance and tokens
- Files: `server/cloud-services.ts`, `tests/cloud-services.test.ts`, new `tests/treg-fake.ts`.
- `CloudServicesConfig.x?: { key: string; monthlyCalls: number }`; `CloudServiceName` gains `"x"`; `CloudIncluded.x?: { calls, max }`; `CloudAllowances.xCalls`.
- Migration `2026-10-09-cloud-x-relay`: `portal_cloud_relay_token`, `portal_cloud_desktop_service_token`, `portal_cloud_x_usage`, and the view `portal_cloud_service_tokens` (UNION ALL of the old table and the relay table).
- Token reads (`tokens`, `authenticate`, `staleSql`) go through the view; `mint` writes `x` to the relay table.
- `authenticateX(token)` returns `{ kind: "machine", machineId }` or `{ kind: "desktop", deviceId, userId }`. A desktop token is honoured only while `portal_cloud_desktop_device` has that device live.
- Option `accountAccess(userId) => { tier } | null` (the account's active paid entitlement).
- `x(request, rest)`: method, path and allow-list; authentication; access (`options.access` or `accountAccess`); configuration; body; reserve; forward; map the answer; give back per spec.
- `KEY_REFUSED.x`, `serviceOf` for `https://treg.to/`, refusals and alerts loops include `x`.
- `desired`/`parse`/`serviceEnv`/`URL_ENV`/`SECRET`/`TOKEN_PREFIX`/`relayUrl` include `x`; `route` dispatches `/api/cloud/services/x/`.
- `desktopToken(deviceId, userId) => { url, token } | null` (null when X is not configured) and `revokeDesktop(deviceId)`.
- `included()` reports `x`.
- Tests: allow-list 404; bad token 401; machine and desktop access paths; 402 for an inactive account; quota at the edge (two parallel calls on the last one); the give-back rules (never sent, 4xx, 429, 5xx, timeout); our key refused gives 503 and the alert state; headers sent to treg and that nothing else is forwarded; 413 for a large body; home token mint, env, plan and stale SQL with the view; a desktop token replaced, revoked and expired.

### Task C3: Desktop route and wiring
- Files: `server/cloud-desktop.ts`, `server/portal.ts`, `server/cloud-machines.ts`, `server/main.ts`, `tests/cloud-desktop.test.ts` (or the existing desktop tests), `deploy/admin.env.example`, `deploy/coolify/admin.env.example`, `docs/consumer-cloud.md`.
- `createCloudDesktop` option `services?: { x(device: { id: string; userId: string }): { url: string; token: string } | null; revoke(deviceId: string): void }`.
- `POST /api/cloud/desktop/services/x`: authenticate `omc_`; a paid, active entitlement or 402; X not configured gives 404; otherwise `{ url, token }`, no-store.
- Session DELETE (sign-out) revokes. Portal: the `devicePath`, `nativeDevicePath` and licence-expired regexes take `services/x`.
- `cloud-machines.ts` passes `accountAccess` from billing's entitlement; `main.ts` reads `OMB_CLOUD_TREG_KEY` and `OMB_CLOUD_X_CALLS_PER_MONTH` and adds them to the Fly requirement, startup lines and docs.
- Tests: paid gets a token that the relay accepts; free gets 402; a second request replaces the first token; sign-out revokes; the route through the portal (native device path, no same-origin header needed).

## App tasks (OpenMausBot)

### Task A1: Remove the person's treg token
- Files:
  - config: `server/config.ts`, `electron/workspace-credentials.mjs`, `electron/diagnostics.mjs`, `electron/main.mjs` (`CREDENTIAL_PATCH`), `src/types/ogb.d.ts`
  - API keys: `src/components/ApiKeys.tsx`, `src/components/SettingsModal.tsx`, `src/locales/en.json`
  - server: `server/index.ts` (configStatus, the external tombstone, the Test route push), `server/routes/x-research.ts` (key Test route)
  - tests: config, diagnostics, workspace-credentials, workspace-credentials-save, ApiKeys, index tests
- Old config with `treg` must still load: a test loads a config.json containing `{"treg":{"token":"x"}}`.

### Task A2: Included credential
- Files:
  - `server/included-services.ts`
  - Cloud home env: `server/cloud-secrets.ts`, `server/cloud-home-start.ts`, `server/config.ts` (`WORKSPACE_CREDENTIAL_ENV`), `electron/diagnostics.mjs`
  - `server/index.ts`: the parent-port dispatch
  - `docs/cloud-pro.md`
- `xCredential(): ServiceCredential | null` (home env held at boot, else the desktop's live credential); `applyIncludedXMessage(access)`.
- Tests: home env; message set and clear; a malformed message ignored; the env names stripped from children.

### Task A3: Client, routes, gate, status
- Files:
  - `server/x-research.ts`: `createXRelayClient({ url, token })`, the error mapping
  - `server/routes/x-research.ts`: deps `credential: () => ServiceCredential | null`
  - `server/index.ts`: `OMB_X_RESEARCH`, configStatus `xResearch`
  - `src/state/store.tsx`
  - tests
- Tests: the path and Bearer header; 402, 429 and 401 sentences; the gate refuses without a credential; configStatus `xResearch.included`.

### Task A4: Desktop token handoff
- Files: `electron/cloud-account.mjs` (`serviceAccess(name)` POST `services/<name>`), `electron/main.mjs` (sync on state change and after server start), node tests.
- Tests: paid and active posts `{ url, token }` to the server; inactive, signed-out or reauth posts `null`; a 402 posts `null`; failures retry on the next refresh.

### Task A5: Access card
- Files: `src/components/bot-settings/AccessSection.tsx`, `src/locales/en.json`, `AccessSection.test.ts`.
- Tests: the included switch; locked for signed out (sign-in action) and for Free (Get Pro); a bot already on can be turned off.

### Task A6: e2e and docs
- Files:
  - `server/x-research.e2e.test.ts`: a loopback relay stub via `OMB_CLOUD_X_URL` and `OMB_CLOUD_X_TOKEN`
  - `scripts/control-omb.ts` (+ test): allows a loopback `OMB_CLOUD_X_URL` and its token; drops `OMB_TREG_URL`
  - `apps/docs/content/docs/connected-apps/index.mdx`
- Tests: the e2e (tools shown, search answered through the stub with the Bearer token); the launcher crossing rules.

## Final

The full suites in both repos (`pnpm lint && pnpm typecheck && pnpm test` for the app; `pnpm check && pnpm test && pnpm test:deploy` for the Admin), then a fresh whole-branch review of both, then hand-off. Nothing is pushed.
