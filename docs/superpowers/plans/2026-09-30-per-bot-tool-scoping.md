# Per-bot Tool Selection Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give bots an owner-controlled tool selection that reduces local-model catalogs and blocks excluded execution, with real Pi and Grok validation.

**Architecture:** Persist one optional selection on each bot and snapshot it into every turn. A shared pure matcher identifies original native and MCP tools. Provider adapters filter native catalogs; a common MCP boundary filters discovery and calls independently of approval modes.

**Tech Stack:** TypeScript, Node 24, Vitest, React, existing MCP clients and YAML dependency.

**Spec:** [Approved design](../specs/2026-09-30-per-bot-tool-scoping-design.md).

**Execution:** Inline implementation following the user's approval and instruction to get it done. Continue between tasks without additional progress approvals. Keep a task ledger in this plan's ignored workspace.

## Global Constraints

- Absent scope preserves current behavior; present empty allowlist permits no tools; deny wins.
- Scope only narrows existing integration, approval, managed-workspace, and guest authority.
- Missing enforcement support or malformed scope must not become unrestricted execution.
- Use original tool names, not normalized provider aliases, as permission identities.
- No new runtime dependency, branding change, generated `dist-server` edits, or release changes.
- Node 24 and portable process launching; no shell commands in production process launches.
- All verification uses disposable fixtures and explicit isolated targets.
- Leave other projects and live OpenMausBot data untouched.
- No new upstream submission until behavior and validation are reviewable; never merge.

## Review Focus

- A selector looks like an alias or a wildcard fragment: it cannot match an adjacent tool.
- A malformed persisted scope reaches a legacy loader: it must not disappear into all-tools defaults.
- A scope changes between turns or during a settings save: stale pooled tools and stale owner checks must not survive.
- A URL-backed server or zero result budget bypasses the stdio gate: selected lists and calls must still be enforced.
- An engine adds optional or package tools after setup: they cannot reappear in a restricted catalog or execute outside scope.

## File Structure and Interfaces

- `shared/tool-scope.ts`: dependency-free parser, original identities, matcher and server eligibility.
- `shared/wire.ts`, `server/contracts.ts`: optional `toolScope: ToolScope` on bots and turns.
- `server/store.ts`, `server/index.ts`, defaults/backup modules: persistence, authenticated settings and dispatch.
- `server/mcp-gate.ts`, `server/mcp-gate-config.ts`: scoped stdio discovery and execution.
- `server/mcp-remote-proxy.ts`, `server/proxy-paths.ts`, `scripts/bundle-server.mjs`: existing HTTP/SSE client exposed through the scoped stdio boundary.
- `server/drivers/chat-mcp-tools.ts`, `server/drivers/openai-chat.ts`: API definitions and execution.
- `server/drivers/pi.ts`, `server/drivers/pi-mcp-extension.ts`: native/package filtering and custom MCP registration.
- `server/drivers/acp/core.ts`, `server/drivers/acp/grok.ts`: scoped session inputs and verified Grok native controls.
- Other provider adapters: common MCP mounting plus provider-specific native enforcement or explicit unsupported restriction errors.
- Existing bot Access settings and client state: owner-facing selection editor and persistence errors.

### Task 1: Pure selection semantics

**Files:** Create `shared/tool-scope.ts`, `shared/tool-scope.test.ts`.

**Produces:**
`ToolScope { allow?: string[]; deny?: string[] }`;
`ToolIdentity = { kind: "native"; name: string } | { kind: "mcp"; server: string; name: string }`;
`parseToolScope(value: unknown): { ok: true; scope: ToolScope | undefined } | { ok: false; error: string }`;
`allowsTool(scope: unknown, tool: ToolIdentity): boolean`;
`canUseMcpServer(scope: unknown, server: string, names?: readonly string[]): boolean`.

- [x] Write literal tests for legacy unrestricted tools; allow-only native drafting; mail-server wildcard; deny precedence; explicit no-tools; original names/case/collisions; invalid object, selectors and limits; server eligibility after overlapping allow/deny.
- [x] Run `corepack pnpm exec vitest run shared/tool-scope.test.ts`; expect missing implementation failure.
- [x] Implement strict bounded parsing and exact matching. Limit each list to 256 selectors, each selector to 1024 characters; accept only complete native or final MCP wildcards.
- [x] Re-run the focused tests; expect all pass.
- [x] Commit the shared contract and tests.

### Task 2: MCP list and call boundary

**Files:** Modify `server/mcp-gate.ts`, `server/mcp-gate.test.ts`, `server/mcp-gate-config.ts`; create `server/mcp-gate-config.test.ts`.

**Consumes:** Task 1 parser/matcher. **Produces:** `gateServer` accepts optional scope; private `OMB_GATE_TOOL_SCOPE` config enforces lists and calls even at budget zero.

- [x] Add real-process tests with two tools and an upstream call log: filtered paginated discovery, allowed execution, no blocked execution marker, malformed scope exit before upstream startup, malformed frames fail closed, legacy pass-through, budget-zero enforcement, typed request-ID correlation and scope env not leaked upstream.
- [x] Run the two gate test files; expect behavioral failures on current code.
- [x] Validate scope before starting upstream, distinguish call/list responses, filter original names and reject blocked requests before forwarding. Preserve legacy pass-through without a scope.
- [x] Re-run gate tests and Task 1; expect all pass.
- [x] Commit the scoped stdio boundary.

### Task 3: Remote MCP transport

**Files:** Create `server/mcp-remote-proxy.ts`, `server/mcp-remote-proxy.test.ts`; modify gate config, `server/proxy-paths.ts`, `scripts/bundle-server.mjs`.

**Consumes:** Existing `RemoteMcpClient` and scoped gate. **Produces:** URL-backed descriptors can be gated without credential-bearing argv.

- [x] Add real HTTP and SSE fixture tests for filtered lists, pagination, required auth headers, allowed/denied calls, cancellation and orderly close; blocked calls must be absent from the remote call log.
- [x] Run the focused remote/gate tests; expect missing implementation or bypass failures.
- [x] Implement a stdio facade using existing request/notify/close methods; scope wraps the facade, and remote errors never expose headers. Register the helper for packaged builds.
- [x] Re-run focused tests and packaged-helper checks; expect correct transports and no orphan sessions.
- [x] Commit remote transport enforcement.

### Task 4: Persist scope and dispatch it everywhere

**Files:** Modify `shared/wire.ts`, `server/contracts.ts`, `server/store.ts`, `server/index.ts`, `shared/new-bot-defaults.ts`, `server/new-bot-defaults.ts`, `shared/team-backup.ts`, `server/team-backup.ts`; add `server/tool-scope.e2e.test.ts` and extend existing persistence/defaults tests.

**Consumes:** Task 1 `ToolScope` and parser. **Produces:** owner-only PATCH field and validated scope on direct/group/queued/resumed turns.

- [x] Add restart/persistence tests, explicit clear versus empty allow, corrupt persisted scope, invalid PATCH rejection, bot proposal rejection, busy-save refusal, trusted widening checks, safe defaults/backup round trips, and literal scope receipt from fake direct and group drivers. Client duplication is verified with the real owner settings workflow in Task 8.
- [x] Run the new API tests and relevant store/defaults/backup tests; expect field loss or invalid settings acceptance on current code.
- [x] Preserve malformed-present restrictions as a failed setup or deny-all state, never an absent field. Wire both sendTurn sites and authenticated settings authority checks. Keep proposal and import authority boundaries intact.
- [x] Re-run focused API and persistence tests; expect pass.
- [x] Commit persistence and dispatch.

### Task 5: Shared API executor

**Files:** Modify `server/drivers/chat-mcp-tools.ts`, `server/drivers/openai-chat.ts` and their tests; extend `server/openai-tools.e2e.test.ts`.

**Consumes:** Task 1 identities and scoped integrations. **Produces:** filtered provider definitions and call-time policy checks for all four shared API drivers.

- [x] Add fake-provider capture tests asserting literal tool names, no excluded schemas, no withheld MCP execution, denial of an excluded `ask_user`, selected cloud-computer tools, and legacy behavior. Verify current schema/call limits apply to the selected catalog.
- [x] Run focused executor/e2e tests; expect excluded definitions or calls on current code.
- [x] Filter before schema conversion/serialization and before approvals or execution; retain original identity mapping through alias collisions.
- [x] Re-run focused tests for OpenAI compatible, Grok API, Mistral and MiniMax; expect pass.
- [x] Commit shared API filtering.

### Task 6: Pi native and custom MCP tools

**Files:** Modify `server/drivers/pi.ts`, `server/drivers/pi.test.ts`, `server/drivers/pi-mcp-extension.ts`, `server/drivers/pi-mcp-extension.test.ts`; add real-CLI verification under `scripts/`.

**Consumes:** Scope and scoped stdio/remote descriptors. **Produces:** custom-MCP capability, selected registration, active native tools and repeated execution checks.

- [x] Add tests for mail-only custom servers, native read/edit/write-only drafting, no-tools without MCP, denied package tools, unavailable enforcement APIs, corrupt config, alias collisions, late tool activation and resume/model changes. Real MCP tools record actual execution.
- [x] Run Pi tests; expect missing custom integration and unrestricted native/catalog failures.
- [x] Mount custom descriptors, load the extension whenever scope is present, filter before TypeBox conversion, intersect active tools on request lifecycle, and block excluded native/MCP execution. Preserve human approval for host and custom tools.
- [x] Re-run Pi/gate/selection tests; expect pass. Verify extension APIs on an isolated official Pi CLI without changing project dependencies.
- [x] Commit Pi integration.

### Task 7: Grok and engine coverage

**Files:** Modify `server/drivers/acp/core.ts`, `server/drivers/acp/grok.ts` and ACP tests; extend Claude/Codex/other adapter paths; add `scripts/verify-tool-scope.ts` and driver coverage tests.

**Consumes:** Scoped turn input, descriptor gate and native identity matcher. **Produces:** engine capability matrix and strict native control contracts.

- [x] Capture real Grok provider payloads against a synthetic endpoint for empty allow, unknown allow, drafting-only and MCP-only profiles; request excluded native/MCP tools and prove absence of execution markers. Verify both new and resumed sessions.
- [x] Add failing ACP pool, permission/full-auto, Claude instance/guest intersection, Codex override, optional native-tool and registry-coverage tests. Enumerate all 18 adapters explicitly.
- [x] Implement the verified Grok native contract with profile restrictions intersected; include scope in session fingerprints and reapply on resume. Apply the common MCP boundary across mounting adapters.
- [x] Implement native contracts where verified. For unsupported restrictions, fail before a provider request with a clear setup error; do not count refusal as usable native support or claim whole-issue completion. Record external contract limitations for resolution with upstream.
- [x] Run affected driver tests and real Grok contract fixture; expect selected payloads and blocked execution. Recheck all engine coverage requirements before declaring Task 7 complete.
- [x] Commit tested driver integration and coverage evidence.

### Task 8: Owner settings and screenshots

**Files:** Modify `src/state/store.tsx`, `src/components/BotSettingsDialog.tsx`, `src/components/bot-settings/AccessSection.tsx`, `useBotSettingsDerived.ts`, client creation/default helpers as needed, locale catalogs and existing settings UI tests; add `docs/tool-selection.md`.

**Consumes:** Wire scope and settings PATCH. **Produces:** All/custom selection, Allow/Exclude lists, explicit no-tools status and actionable errors.

- [x] Capture the before screenshot from the real isolated settings fixture.
- [x] Add behavior tests for editing/saving/clearing, explicit empty allow, invalid input, unsupported engine status, busy/errors, switching bots during pending saves, and duplication retaining restrictions from the creation request onward.
- [x] Run focused settings/client tests; expect missing controls or lost fields.
- [x] Implement the small advanced Access section, reuse custom-server selection and save/error patterns, add localized copy and concise examples.
- [x] Run focused tests and locale generation/check; capture after screenshots and verify persisted state in the real fixture.
- [x] Commit UI, docs and screenshots needed for review.

### Task 9: Live model proof and upstream submission

**Files:** Verification scripts/docs, PR body and external screenshots; no unrelated source changes.

- [x] Run actual Pi and Grok turns against a real installed local model in disposable homes with a bounded context. Prove native drafting and selected custom MCP execution, plus a blocked tool attempt. Record runtime/model versions, exact catalog counts/bytes, provider token usage where supplied, results and measured memory pressure.
- [x] Leave other projects and their test devices running. Use sequential local-model turns and bounded resources; report any concrete remaining live-test blocker.
- [x] Run `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm check:electron`, locale checks and relevant packaged-helper tests. Resolve failures within scope or reproduce unchanged-main failures and state them exactly.
- [x] Review the entire final diff for scope, generated files, secrets, machine paths, dependency and release changes. Request one final fresh review only when the branch is complete; fix material findings with failing regression tests.
- [x] Push the authorized fork branch with normal hooks and record exact tested CI commits, including separately tracked prerequisite fixes. Wait for authoritative results.
- [x] Recheck issue and overlapping PRs, then open the authorized draft PR with screenshots, exact checks and live-device/model evidence.
- [x] Attach every created PR to this Codex task; report its URL, validation and remaining limitations. Never merge.

Submitted drafts: [tool selection #2101](https://github.com/milind-soni/OpenMausBot/pull/2101)
and [Windows fixture cleanup #2100](https://github.com/milind-soni/OpenMausBot/pull/2100).
The feature diff excludes its CI prerequisites, maintainer PR #2088 and the
separate cleanup PR. The full composed fork run passed all 26 selected checks;
the [verification record](../../verification/tool-selection.md#completed-contribution-checks)
identifies the tested commits and the local suite's limits.

Maintainer agreement on the approach and engine support boundary, prerequisite
merges, and green upstream CI on the clean feature branch remain required before
presenting the draft as merge ready. No whole-issue closure or merge is claimed.
