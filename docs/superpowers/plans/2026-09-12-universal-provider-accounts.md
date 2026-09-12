# Universal Provider & Account Connections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified provider/account manager that lets users create named API connections, discover models, and see existing account-based engines from one Settings surface without bypassing official authentication flows.

**Architecture:** Preserve OpenMausBot's existing `instances` map and provider-driver SPI. API connections are represented as normal `openai-compat` instances with friendly metadata and preset defaults; account-based providers continue using their existing provider-specific login/account mechanisms. Add a small server-side catalog/status layer and a React provider-manager surface rather than introducing a second persistence system.

**Tech Stack:** TypeScript 5.8+, React 19, Zod 4, Vitest 4, existing OpenMausBot driver/harness/config architecture.

**Spec:** `docs/superpowers/specs/2026-09-12-universal-provider-accounts-design.md`

## Global Constraints

- Never scrape private session tokens or bypass vendor authentication; use official login/API-key mechanisms already supported by each provider.
- API secrets remain write-only across HTTP responses; never expose stored key values or environment values to the renderer.
- Preserve the existing `instances` configuration format and multi-instance behavior.
- Model discovery is opportunistic and must fall back to configured/default models when an endpoint is unavailable.
- Do not implement quota scraping or automated quota-evasion failover.
- Keep the harness loopback/security boundary intact; user-controlled values must not become shell commands.

---

### Task 1: Provider catalog and connection normalization

**Files:**
- Create: `server/providers/catalog.ts`
- Create: `server/providers/catalog.test.ts`
- Modify: `server/config.ts`

**Interfaces:**
- Consumes: existing `InstanceConfig`, `InstanceConfigMap`, `openai-compat` driver configuration and current config persistence helpers.
- Produces: `ProviderConnectionPreset`, `ProviderConnectionSummary`, `normalizeProviderConnectionInput()` and `providerConnectionPresets()` for server and UI/API consumers.

- [ ] **Step 1: Write failing tests for preset normalization**

```ts
it("normalizes an OpenAI connection into an openai-compat instance", () => {
  expect(normalizeProviderConnectionInput({
    provider: "openai",
    name: "OpenAI Personal",
    apiKey: "sk-test",
  })).toMatchObject({
    driver: "openai-compat",
    displayName: "OpenAI Personal",
    config: { url: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_COMPAT_API_KEY" },
    environment: { OPENAI_COMPAT_API_KEY: "sk-test" },
  });
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm vitest run server/providers/catalog.test.ts`
Expected: FAIL because the provider catalog module does not exist yet.

- [ ] **Step 3: Implement the provider catalog**

Add typed presets for `openai`, `openrouter`, `groq`, `mistral`, `nvidia-nim`, and `custom-openai-compatible`. Store the API key only in the instance environment under a generated secret env name, never in a returned connection summary. Validate names and URLs with Zod; accept a user-supplied NIM/custom base URL instead of assuming every deployment shares one endpoint.

- [ ] **Step 4: Add server-side normalization helpers**

Implement `normalizeProviderConnectionInput(input)` returning `{ instanceId, instanceConfig }`, with a slug derived from the requested display name plus a collision-safe numeric suffix. Reject empty names, non-http(s) URLs, and API keys containing control characters.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run server/providers/catalog.test.ts`
Expected: PASS.

Commit: `feat: add provider connection catalog`

---

### Task 2: Provider connection API and safe model discovery/status

**Files:**
- Create: `server/providers/api.ts`
- Create: `server/providers/api.test.ts`
- Modify: `server/index.ts`
- Modify: `server/harness/registry.ts` (only where needed to refresh a newly persisted instance without restarting the process)

**Interfaces:**
- Consumes: Task 1 `normalizeProviderConnectionInput()` and existing config persistence/driver registry.
- Produces: `GET /api/provider-connections`, `POST /api/provider-connections`, `DELETE /api/provider-connections/:instanceId`, and `POST /api/provider-connections/:instanceId/test`.

- [ ] **Step 1: Write failing route tests**

Cover: listing returns connection metadata but never an API key; create persists a named `openai-compat` instance; duplicate names produce separate IDs; delete removes only the selected instance; test returns `available`/`unavailable` without echoing authorization headers.

- [ ] **Step 2: Run focused route tests and confirm failure**

Run: `pnpm vitest run server/providers/api.test.ts`
Expected: FAIL because the route module and handlers do not exist.

- [ ] **Step 3: Implement the safe connection API**

Use the existing config update/persistence path. Store secrets in the same 0600 workspace config mechanism already used for provider environment values. Build response objects containing `id`, `displayName`, provider preset, URL, enabled state, model catalog, capability flags, and authentication state; omit key values entirely. Reuse the driver's model catalog/refresh behavior so `/models` remains the single discovery implementation.

- [ ] **Step 4: Add connection test behavior**

For an `openai-compat` connection, call the existing driver snapshot/model refresh path. Return structured error categories for bad credentials, unavailable endpoint, and model-catalog failure. Do not return upstream response bodies longer than the server's existing short error limit.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run server/providers/api.test.ts`
Expected: PASS.

Commit: `feat: add provider connection api`

---

### Task 3: Unified Settings provider manager

**Files:**
- Create: `src/components/ProviderManager.tsx`
- Create: `src/components/ProviderManager.test.tsx`
- Modify: `src/components/SettingsModal.tsx`
- Modify: `src/components/EnginesSettings.tsx`

**Interfaces:**
- Consumes: Task 2 provider-connection HTTP endpoints; existing engine/account components and settings styling conventions.
- Produces: one Settings surface showing API connections and existing account-based engine instances with add/test/delete/select affordances.

- [ ] **Step 1: Write failing UI tests**

Test that the manager renders provider presets, shows an existing Claude account as an account connection, never renders an API key value returned by the API, and renders discovered model IDs after a successful test/discovery response.

- [ ] **Step 2: Run the focused UI tests and confirm failure**

Run: `pnpm vitest run src/components/ProviderManager.test.tsx`
Expected: FAIL because the manager component does not exist.

- [ ] **Step 3: Implement the provider manager UI**

Add `Settings -> AI Providers` as the central surface. Provide provider cards for OpenAI, OpenRouter, Groq, Mistral, NVIDIA NIM, and Custom OpenAI-compatible. For account-based engines, show existing configured instances from the current engine list and link to their existing setup/account editors instead of creating a new authentication implementation. Each API card supports name, base URL when relevant, API key entry, model refresh/test, enable/disable, and removal.

- [ ] **Step 4: Integrate without removing existing screens**

Keep `EnginesSettings`, `ClaudeAccountSettings`, and other provider-specific screens functional. The new manager becomes an aggregation layer; it does not duplicate or fork their account state.

- [ ] **Step 5: Run tests/lint and commit**

Run: `pnpm vitest run src/components/ProviderManager.test.tsx`
Expected: PASS.

Commit: `feat: add unified provider manager`

---

### Task 4: Capability presentation and OpenAI-compatible message preservation

**Files:**
- Create: `server/providers/capabilities.ts`
- Create: `server/providers/capabilities.test.ts`
- Modify: `server/drivers/openai-chat.ts`
- Modify: `server/drivers/openai-compat.ts`

**Interfaces:**
- Consumes: current `SendTurnInput`, `RuntimeEvent`, OpenAI chat-completions wire format.
- Produces: normalized capability summaries and compatibility for structured message parts/tool declarations when the harness has them, without inventing tool execution semantics.

- [ ] **Step 1: Write failing tests for capability detection**

Test preset-derived baseline capabilities (`streaming`, `reasoning`, `modelDiscovery`) and explicit endpoint overrides. Keep tool support false unless the endpoint/driver can actually preserve the required wire fields.

- [ ] **Step 2: Write failing message preservation tests**

Test that OpenAI-compatible request construction can carry assistant/user structured content and tool-call metadata when supplied, while keeping the existing plain-text path unchanged.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `pnpm vitest run server/providers/capabilities.test.ts server/drivers/openai-chat.test.ts`
Expected: FAIL on the new structured-message cases.

- [ ] **Step 4: Implement capability summaries and safe request preservation**

Extend the shared runtime's internal message/request types only where the existing contracts can supply the data. Preserve unknown tool-call metadata in the native request but do not add an automatic tool execution loop in this task. Keep existing streaming/reasoning events unchanged.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm vitest run server/providers/capabilities.test.ts server/drivers/openai-chat.test.ts`
Expected: PASS.

Commit: `feat: expose provider capabilities`

---

### Task 5: Documentation and verification

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-universal-provider-accounts-design.md`
- Create: `docs/providers/unified-connections.md`

**Interfaces:**
- Consumes: all implemented behavior from Tasks 1-4.
- Produces: user-facing setup documentation and a tested branch ready for review.

- [ ] **Step 1: Document setup and security behavior**

Document how to add named API connections, how model discovery works, which provider login flows remain provider-specific, and that API secrets are write-only in the UI/API.

- [ ] **Step 2: Run the repository verification suite**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm lint`
Expected: PASS.

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 3: Compare the branch against the fork baseline**

Use GitHub compare for `main...feat/universal-provider-accounts` and verify only the intended design, provider-manager, provider API, capability, test, and documentation files changed.

- [ ] **Step 4: Final commit**

Commit: `docs: document unified provider connections`
