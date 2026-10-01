# MCP Sign-in (sub-project A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A URL MCP server that requires OAuth (e.g. Higgsfield) can be signed into from the desktop app; tokens are stored, refreshed, and sent to every engine as `Authorization: Bearer`.

**Architecture:** Three new server modules — discovery (`mcp-oauth-discovery.ts`), storage (`mcp-oauth-store.ts`), and the flow/refresh manager (`mcp-oauth.ts`) modelled on `server/drivers/chatgpt-plan-auth.ts` (loopback listener, PKCE, state check, polled status). `server/index.ts` gains four routes and injects tokens where turns get their servers. The MCP servers panel gains a status chip and Sign in / Sign out.

**Tech Stack:** Node 24 (`~/.nvm/versions/node/v24.14.1/bin`), TypeScript, zod, vitest, React.

**Spec:** `docs/superpowers/specs/2026-09-30-mcp-sign-in-and-plugin-catalog-design.md` (section A). Catalog (B) and phone labels get their own plans.

## Global Constraints

- Desktop only: sign-in starts only when `!isProxied(req) && isLoopbackHost(req.socket.remoteAddress)`; otherwise `409` with "Sign in from the computer running this workspace."
- Tokens live in `${DATA_DIR}/mcp-oauth.json`, written with `writeFileAtomic(..., { mode: 0o600 })`; never in API responses, logs, or phone payloads.
- Tokens are bound to the server URL; a URL change or removal deletes them.
- PKCE `S256` is required; a server without it is not signable.
- Metadata endpoints must be `https:` (plain `http:` only for loopback hosts, used by tests).
- Refresh when a token expires within 2 minutes; single-flight per server.
- Pending sign-in lifetime 5 minutes.
- Run tests with Node 24: `export PATH=$HOME/.nvm/versions/node/v24.14.1/bin:$PATH`.

## Review Focus

- A server listed by URL whose first 401 has no OAuth metadata must keep today's message ("answered HTTP 401…"), not claim it needs sign-in. → Task 2 test.
- Signing in twice concurrently for one server must reuse the waiting flow, not open two listeners. → Task 4 test.
- A callback with the wrong `state` must not consume the flow. → Task 4 test.
- Editing a server's URL must drop its tokens so a token is never sent to a different host. → Task 5 test.
- A turn must not mount a server that needs sign-in (it would 401 mid-turn). → Task 5 test.

---

### Task 1: OAuth metadata discovery

**Files:**
- Create: `server/mcp-oauth-discovery.ts`
- Test: `server/mcp-oauth-discovery.test.ts`

**Interfaces:**
- Produces:
  - `interface McpAuthMetadata { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string; revocationEndpoint?: string; scopes?: string[]; resource: string }`
  - `resourceMetadataUrl(wwwAuthenticate: string | null): string | null`
  - `discoverMcpAuth(mcpUrl: string, wwwAuthenticate: string | null, options?: { fetch?: typeof fetch; signal?: AbortSignal }): Promise<McpAuthMetadata | null>`
  - `isAllowedAuthUrl(value: string): boolean`

- [ ] **Step 1: Write the failing tests** — cover: `resource_metadata="…"` parsed from a Bearer challenge; discovery via header hint; fallback to `/.well-known/oauth-protected-resource`; fallback to MCP origin when no PRM; OIDC fallback; `null` when S256 missing; `null` for non-https metadata endpoints on non-loopback hosts. Use a `fetch` stub mapping URL → JSON.

- [ ] **Step 2: Run** `npx vitest run server/mcp-oauth-discovery.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement** — PRM lookup order: header hint, then `${origin}/.well-known/oauth-protected-resource${path}`, then `${origin}/.well-known/oauth-protected-resource`. Authorization-server metadata: `${issuer}/.well-known/oauth-authorization-server`, then `/.well-known/openid-configuration`. Require `authorization_endpoint`, `token_endpoint`, and `code_challenge_methods_supported` containing `S256` (treat absence as unsupported). Each fetch: 5 s timeout, `accept: application/json`, response ≤ 64 KB. `resource` = MCP URL without hash.

- [ ] **Step 4: Run** the test — expect PASS.

- [ ] **Step 5: Commit** `feat(mcp): discover OAuth metadata for URL servers`

### Task 2: Probe reports "needs sign-in"

**Files:**
- Modify: `server/mcp-http.ts` (`McpHttpError` gains `wwwAuthenticate`; `post()` and the SSE GET pass it on 401)
- Modify: `server/mcp-probe.ts` (`McpProbeResult` failure gains `auth?: "required"`; 401 → `discoverMcpAuth`)
- Modify: `server/testing/fake-http-mcp-server.ts` (options `wwwAuthenticate?: string`, `acceptBearer?: (header: string | undefined) => boolean`)
- Test: `server/mcp-probe.test.ts`

**Interfaces:**
- Consumes: `discoverMcpAuth` (Task 1)
- Produces: `McpProbeResult = { ok: true; tools } | { ok: false; error: string; auth?: "required" }`; error text for auth: `"This server needs you to sign in."`

- [ ] **Step 1: Write failing tests** — (a) fake server 401 + `WWW-Authenticate: Bearer resource_metadata="<fake PRM url>"` with a fake AS → `{ ok: false, auth: "required", error: "This server needs you to sign in." }` in < 1 s; (b) 401 with no metadata → existing `"The server answered HTTP 401. Check the address and headers."`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — in `probeRemoteMcpServer`'s catch: `if (error instanceof McpHttpError && error.status === 401) { const meta = await discoverMcpAuth(server.url, error.wwwAuthenticate ?? null, { signal: AbortSignal.timeout(5_000) }).catch(() => null); if (meta) return { ok: false, auth: "required", error: "This server needs you to sign in." }; }` before the generic status branch.
- [ ] **Step 4: Run** probe + http tests — PASS.
- [ ] **Step 5: Commit** `fix(mcp): say a URL server needs sign-in instead of blaming headers`

### Task 3: Token store

**Files:**
- Create: `server/mcp-oauth-store.ts`
- Test: `server/mcp-oauth-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface McpOAuthTokens { access: string; refresh?: string; expiresAt?: number; scope?: string }
  interface McpOAuthRecord { url: string; state: "needs-sign-in" | "signed-in"; issuer?: string; clientId?: string; redirectUri?: string; tokenEndpoint?: string; revocationEndpoint?: string; tokens?: McpOAuthTokens }
  class McpOAuthStore {
    constructor(file: string)
    get(name: string, url: string): McpOAuthRecord | undefined   // undefined when URL differs
    put(name: string, record: McpOAuthRecord): void
    delete(name: string): void
    client(issuer: string, redirectUri: string): string | undefined
    putClient(issuer: string, redirectUri: string, clientId: string): void
  }
  ```
- [ ] **Step 1: Failing tests** — file created 0600; `get` with a different URL returns `undefined`; `delete` removes; a corrupt file reads as empty (and is not overwritten until the next `put`); client cache round-trips.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — zod schema `{ servers: record, clients: record }`; read-through on every call (small file, avoids cross-process staleness); `writeFileAtomic(file, json, { mode: 0o600 })`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mcp): store OAuth tokens for URL servers`

### Task 4: Sign-in flow and refresh (`McpOAuthManager`)

**Files:**
- Create: `server/mcp-oauth.ts`
- Create: `server/testing/fake-oauth-server.ts` (PRM, AS metadata, `/register`, `/authorize` → 302 to `redirect_uri?code&state`, `/token` for `authorization_code` + `refresh_token`, `/revoke`; configurable `expiresIn`, `rejectRefresh`)
- Test: `server/mcp-oauth.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces:
  ```ts
  type McpSignInPhase = "waiting" | "succeeded" | "failed" | "cancelled" | "expired";
  interface McpSignInStatus { phase: McpSignInPhase; flowId: string; authorizationUrl: string | null; expiresAt: string; message?: string }
  class McpOAuthError extends Error { code: "not-oauth" | "no-registration" | "busy" }
  class McpOAuthManager {
    constructor(options: { file: string; fetch?: typeof fetch; lifetimeMs?: number; onChange?: (name: string) => void })
    authState(name: string, url: string): "signed-in" | "needs-sign-in" | "none"
    markNeedsSignIn(name: string, url: string): void
    start(name: string, url: string, wwwAuthenticate?: string | null): Promise<McpSignInStatus>
    status(name: string, flowId: string): McpSignInStatus | undefined
    cancel(name: string): void
    signOut(name: string, url: string): Promise<void>   // revoke best-effort, then delete
    forget(name: string): void                          // delete without network
    accessToken(name: string, url: string): Promise<string | null> // refreshes when due; null = not usable
    dispose(): void
  }
  ```
- [ ] **Step 1: Failing tests** — full happy path against the fake (start → fetch `authorizationUrl` with `redirect: "follow"` which lands on the loopback callback → status `succeeded` → `accessToken` returns the fake's token); concurrent `start` returns the same `flowId`; wrong `state` → 400 and flow still `waiting`; expiry after `lifetimeMs` → `expired` and listener closed; refresh when `expiresAt` within 2 min; concurrent `accessToken` calls cause one refresh request; `rejectRefresh` → `null` and `authState` = `needs-sign-in`; no DCR endpoint → `McpOAuthError("no-registration")`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — per-name flow map; loopback `createServer` on `127.0.0.1`, preferred port `20000 + fnv1a(url) % 20000`, fallback `0`; redirect `http://127.0.0.1:<port>/mcp-oauth/callback`; DCR body `{ client_name: "OpenMausBot", redirect_uris: [redirectUri], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }`, cached by issuer + redirectUri; authorize params `response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method=S256, resource, scope?`; callback validation copied from `chatgpt-plan-auth.ts` (host, path, single-valued params, `timingSafeEqual` on state, `consumed` flag); token exchange as form POST; browser page text "Signed in. You can close this tab and return to OpenMausBot." / failure text; refresh single-flight via `Map<name, Promise>`; `invalid_grant` or 400/401 on refresh → record `needs-sign-in`, tokens dropped; network error → keep current token if not expired.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(mcp): sign in to OAuth MCP servers from the desktop`

### Task 5: Server wiring

**Files:**
- Modify: `server/index.ts` — construct `mcpOAuth = new McpOAuthManager({ file: join(DATA_DIR, "mcp-oauth.json") })`; routes; listing field; token injection; URL-change/delete cleanup; Test route.
- Modify: `server/mcp-registry.ts` — `RemoteMcpServerListing.auth?: "signed-in" | "needs-sign-in"`.
- Test: `server/index.test.ts` (new `it` beside the URL-server test)

**Routes (all behind the existing `/api/mcp/servers` auth):**
- `POST /api/mcp/servers/:name/sign-in` → loopback gate (409 `remote_workspace`), must be a remote server (400), `mcpOAuth.start` → `200 { auth }`; `McpOAuthError` → 400 with a sentence per code.
- `GET /api/mcp/servers/:name/sign-in/:flowId` → `200 { auth }` or 404.
- `DELETE /api/mcp/servers/:name/sign-in` → cancel → `200 { ok: true }`.
- `POST /api/mcp/servers/:name/sign-out` → `200 mcpServerResponse()`.

**Behaviour:**
- `mcpServerResponse()` adds `auth` to remote listings when `authState` ≠ `none`.
- `engineMcpServers(bot)` drops remote servers whose `authState` is `needs-sign-in`.
- New `async function authorizedMcpServers(bot)` = `engineMcpServers(bot)` + for each remote with state `signed-in`: `const token = await mcpOAuth.accessToken(name, url)`; token → `headers.Authorization = \`Bearer ${token}\``; null → drop. Replace the two turn call sites (`const custom = engineMcpServers(bot)` inside the 1:1 and room turn setup) with `await authorizedMcpServers(bot)`.
- Test route: signed-in → inject header before probing; result `auth: "required"` → `mcpOAuth.markNeedsSignIn`.
- PUT with a changed URL, and DELETE → `mcpOAuth.forget(name)`.
- `mcpOAuth.dispose()` on shutdown where other auth controllers are disposed.

- [ ] **Step 1: Failing test** — fake OAuth + fake MCP requiring the issued bearer: add server → Test → `auth: "required"`, listing `auth: "needs-sign-in"` → sign-in via route, follow `authorizationUrl` → status `succeeded` → listing `auth: "signed-in"`, no token text anywhere in responses → Test passes with tools → enable, and assert `authorizedMcpServers` output (via the existing turn-integration seam or a small exported test hook) carries `Authorization: Bearer <token>` → PUT a new URL → listing has no `auth` → DELETE clean. Also: a request with `x-forwarded-for` gets 409.
- [ ] **Step 2: Run** `npx vitest run server/index.test.ts -t "OAuth"` — FAIL.
- [ ] **Step 3: Implement** the routes and behaviour above.
- [ ] **Step 4: Run** the new test, then `npx vitest run server/mcp-*.test.ts server/index.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(mcp): wire URL-server sign-in into the API and turns`

### Task 6: MCP servers panel

**Files:**
- Modify: `src/components/McpServersPanel.tsx`
- Modify: `src/locales/en.json` (`mcp.auth.signedIn`, `mcp.auth.needsSignIn`, `mcp.auth.signIn`, `mcp.auth.signOut`, `mcp.auth.cancel`, `mcp.auth.waiting`, `mcp.auth.failed`, `mcp.auth.remote`)
- Test: `src/components/McpServersPanel.test.ts` (or the existing panel test file)

- [ ] **Step 1: Failing test** — a remote listing with `auth: "needs-sign-in"` renders the chip and a Sign in button; clicking POSTs sign-in, calls `openExternalLink` with the returned https URL (a non-https URL is refused), polls the flow until `succeeded`, then reloads the list; `auth: "signed-in"` shows Sign out.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `RemoteMcpListing.auth?`; chip next to the name; buttons in the action row; poll every 1.5 s while `waiting`; Cancel sends DELETE; `409` shows `mcp.auth.remote`; a Test result with `auth: "required"` shows the Sign in button instead of the red error.
- [ ] **Step 4: Run** the test and `pnpm i18n:check` — PASS.
- [ ] **Step 5: Commit** `feat(mcp): sign in and out of URL servers from the MCP panel`

### Task 7: Verification

- [ ] `npx tsc -p tsconfig.server.json --noEmit` and `npx tsc -p tsconfig.json --noEmit` — clean.
- [ ] `npx vitest run server/mcp-* server/index.test.ts src/components/McpServers*` — PASS.
- [ ] Live check against Higgsfield with a scratch data dir (`OMB_DATA_DIR`): probe → needs sign-in; start → authorization URL on `clerk.higgsfield.ai` (sign-in itself needs Omkar).
- [ ] Hand-off: OMB2 side-by-side build for Omkar to sign in and run a bot turn.
