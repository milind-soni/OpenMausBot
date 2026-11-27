# OpenCode Go Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenCode Go as an optional ACP-backed OpenMausBot engine with dynamic models, write-only credentials, setup UX, and comprehensive tests.

**Architecture:** Extend the generic ACP support SPI with an optional asynchronous model resolver and keep OpenCode-specific behavior in `server/drivers/acp/opencode-go.ts`. Load the API key from config/environment into the child process only, register the driver in the normal fleet, and reuse the existing registry, `/api/instances`, setup UI, and ACP event machinery.

**Tech Stack:** TypeScript, Node 24, Vitest, React, Vite, pnpm, JSON-RPC ACP over stdio.

---

## File map

- Create `server/drivers/acp/opencode-go.ts`: OpenCode Go executable, catalog, credential and ACP support definition.
- Create `server/drivers/acp/opencode-go.test.ts`: resolver, config, environment, catalog and driver contract tests.
- Modify `server/drivers/acp/core.ts`: optional async model resolution without changing existing harness behavior.
- Modify `server/drivers/builtIn.ts`: register the driver.
- Modify `server/config.ts`: persist and inject `opencodeGo.apiKey`, while preserving write-only semantics.
- Modify `server/index.ts`: expose only configured status and accept the new credential patch.
- Modify `src/components/ApiKeys.tsx` and `src/components/SettingsModal.tsx`: add the optional OpenCode Go credential row.
- Modify `src/components/Onboarding.tsx`: show OpenCode Go in the engine check.
- Modify `src/components/ProviderIcons.tsx`: add a stable OpenCode mark/fallback.
- Modify `server/testing/fake-acp-cli.ts` and `server/drivers/acp/acp.test.ts`: exercise exact ACP ordering/model selection with a fake CLI.
- Modify `docs/opencode-go.md`: document prerequisites, live links, privacy boundary, and opt-in behavior.

### Task 1: Extend ACP model resolution

**Files:** `server/drivers/acp/core.ts`, `server/drivers/acp/acp.test.ts`

- [ ] Add a failing test proving an ACP support can provide `resolveModels(environment)` and that the created instance exposes the resolved catalog while existing static supports remain unchanged.
- [ ] Run `pnpm vitest run server/drivers/acp/acp.test.ts`; expect the new test to fail because `AcpSupport` has no resolver.
- [ ] Add `resolveModels?: (environment) => Promise<ModelCatalog>` to `AcpSupport`; resolve it at creation and expose `refreshModels()` so `/api/instances` can replace the existing instance catalog without recreating it, falling back to `support.models` when it rejects.
- [ ] Run the focused test and then the existing ACP suite; expect all tests to pass.
- [ ] Commit `feat(acp): support dynamic model catalogs`.

### Task 2: Implement OpenCode Go support and catalog

**Files:** `server/drivers/acp/opencode-go.ts`, `server/drivers/acp/opencode-go.test.ts`

- [ ] Write failing tests for default config `{ cli: "opencode", fullAuto: false, workspace: undefined }`, `opencode acp` arguments, deletion of unrelated provider API-key variables, and full `opencode-go/<id>` model IDs.
- [ ] Write failing catalog tests using injected `fetch`: accept only valid model records, preserve deterministic labels, reject malformed/empty payloads, and return the last successful cache/static fallback on timeout or HTTP failure.
- [ ] Run the focused tests and verify they fail for missing exports/driver.
- [ ] Implement `fetchOpenCodeGoModels(fetcher)` with a module cache, 8-second timeout via `AbortController`, validation of `data`/array payloads, and a static fallback containing the documented Go model ids. Do not log response bodies or credentials.
- [ ] Implement `OpenCodeGoDriver = createAcpDriver({ driverKind: "opencodeGo", displayName: "OpenCode Go", defaultCli: "opencode", nativeSource: "opencode-go.acp", spawnArgs: () => ["acp"], transformEnv: stripForeignProviderKeys, pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: env => Boolean(env.OPENCODE_API_KEY), resolveModels: () => fetchOpenCodeGoModels() })`; the environment transform must remove known unrelated provider keys and leave the intentionally injected OpenCode key.
- [ ] Add cross-platform setup commands, docs URL, and a login note that never asks OpenMausBot to edit OpenCode auth files.
- [ ] Run the focused tests and commit `feat(acp): add OpenCode Go driver`.

### Task 3: Wire credential storage and registration

**Files:** `server/config.ts`, `server/index.ts`, `server/drivers/builtIn.ts`, `server/index.test.ts`, `server/config.test.ts` if needed

- [ ] Add failing tests proving `opencodeGo.apiKey` is loaded from `OPENCODE_API_KEY`, saved to disk, passed only in the configured instance environment, and never appears in `configStatus()` or GET `/api/config`.
- [ ] Run the focused tests and confirm failure before implementation.
- [ ] Add `opencodeGo?: { apiKey?: string }` to `AppConfig`, load the environment fallback with disk override, merge the key only into `entry.environment` for `opencodeGo` instances, include `opencodeGo` in accepted config patches, and expose `{ configured: boolean }` in status.
- [ ] Add `OpenCodeGoDriver` to `BUILT_IN_DRIVERS`; keep the default fleet optional by adding `opencodeGo: { driver: "opencodeGo" }` only when the user explicitly configures it or when the default fleet policy is updated to show unavailable optional engines without selecting them.
- [ ] Run config/index tests and inspect serialized bodies to verify the secret is absent.
- [ ] Commit `feat(config): wire OpenCode Go credentials`.

### Task 4: Add settings, onboarding, and icon integration

**Files:** `src/components/ApiKeys.tsx`, `src/components/SettingsModal.tsx`, `src/components/Onboarding.tsx`, `src/components/ProviderIcons.tsx`

- [ ] Add component tests or existing test-style coverage for the credential row payload `{ opencodeGo: { apiKey } }` and the onboarding engine label `OpenCode Go`.
- [ ] Run the new focused tests and verify the missing row/label failure.
- [ ] Add `opencodeGo` to `ConfigSection`, `SECTIONS`, and `CREDENTIALS` with optional copy, live documentation link, and no value rendering; add the row to Connections.
- [ ] Add the engine row using `driverKind === "opencodeGo"` and add the provider mark without changing unavailable-engine behavior.
- [ ] Run typecheck and frontend tests; commit `feat(ui): add OpenCode Go setup surfaces`.

### Task 5: Verify ACP runtime behavior end to end

**Files:** `server/testing/fake-acp-cli.ts`, `server/drivers/acp/opencode-go.test.ts`

- [ ] Add a fake-CLI mode that records received JSON-RPC methods/model config in a test-only temporary file and emits initialize, session/new, session/set_config_option, session/update, permission, and prompt result messages.
- [ ] Add failing integration tests asserting order `initialize -> session/new/load -> session/set_config_option(model=opencode-go/...) -> session/prompt`, no duplicate final text, permission allow/deny, resume fallback, cancellation, malformed JSON-RPC, and process cleanup.
- [ ] Run the focused tests and verify failures are behavior failures rather than import/type errors.
- [ ] Implement only the smallest driver/core changes needed to pass these tests; preserve existing ACP semantics for Grok, Gemini, and Kimi.
- [ ] Run all ACP tests and commit `test(acp): cover OpenCode Go protocol flow`.

### Task 6: Documentation and final verification

**Files:** `docs/opencode-go.md`, `README.md` only if the repository’s engine documentation index requires it

- [ ] Document CLI installation via the official CLI guide, `opencode auth login` as a user-managed alternative, API-key scope, model catalog behavior, supported platforms, and the fact that live tests are opt-in.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm check:electron`, and `git diff --check` from the worktree.
- [ ] Search the diff and test output for `OPENCODE_API_KEY` values or serialized secrets; only variable names and configured booleans may remain.
- [ ] Commit `docs: document OpenCode Go setup`.

## Self-review

- The plan covers every scope item: ACP driver, dynamic catalog, credential boundary, registry/setup/model picker, session/tool/permission/cancellation tests, documentation, and cross-platform checks.
- No runtime implementation is permitted before its focused failing test; each implementation task has an explicit RED/GREEN sequence.
- The only unresolved product choice is optional-fleet visibility. The implementation will follow the repository’s existing policy: configured instances are shown, and OpenCode Go is never selected as a runnable default without CLI plus credential readiness.
