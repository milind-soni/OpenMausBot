# MCP Registry (Connections Center, part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a person add their own MCP server — local stdio or remote HTTP — test it before enabling it, see the tools it exposes, and grant individual tools to individual bots. Composio becomes one connection method rather than the only one.

**Architecture:** Every user-added server, stdio or remote, is reached through one harness-owned stdio bridge process. That is not incidental: `server/contracts.ts:162` already gives the reason for the Composio bridge — a harness-controlled bridge turns connection behaviour into something consistent across provider CLIs. The same bridge is where the per-tool allowlist is enforced, by extending `createGateInterceptor` (`server/mcp-bridge.ts:171`), which already intercepts `tools/call` frames.

**Tech Stack:** TypeScript, Node 24, Vitest, JSON-RPC over stdio, React, zod.

**Spec:** none — this plan is its own spec.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). Load-bearing here:

- **Secrets are write-only.** An MCP server's `env` values and HTTP `headers` routinely carry tokens. The registry stores them and must never return them — the read path returns `configured: true` per secret key, exactly as `config.ts` does for provider credentials.
- **Imports land disabled.** A newly added server is off for every bot until someone enables it.
- **The capability rule.** A driver that cannot mount custom MCP must not be offered the control. This means a new `customMcp` capability flag on `ProviderAdapter`.
- **Unknown config round-trips.** A server entry written by a newer build must load and degrade, not throw.

**Depends on:** nothing. Can run in parallel with P1/P2.

---

## Background

MCP is already everywhere in this codebase — and nowhere a user can reach.
`server/drivers/claude.ts:562-631` assembles `mcpServers` from six harness-owned
integrations (composio, computer, agents, phone, dweb, and the `ogb` permission proxy),
writes them to a temp config, and passes it to the CLI. `server/mcp-bridge.ts` is a
complete, tested stdio bridge with a liveness watchdog and a policy gate.
`server/container-mcp.ts` and `server/vps-container-mcp.ts` are two entry points onto it.

What does not exist: any way for a person to add a server. `server/config.ts` has no
`mcpServers` key. The only user-authored MCP that reaches a bot is whatever was already
in a user's own Antigravity config file, which `server/drivers/antigravity.ts:214`
merges but does not manage.

---

## File map

- Create `server/mcp-registry.ts`: validate, store, list, and redact user MCP server definitions.
- Create `server/mcp-registry.test.ts`.
- Create `server/mcp-probe.ts`: connect to a server, run `initialize` + `tools/list`, return the tool list or a typed failure. Bounded and cancellable.
- Create `server/mcp-probe.test.ts`.
- Create `server/mcp-user-entry.ts`: the bridge entry point a driver spawns — stdio child or HTTP relay, with the tool allowlist gate in front.
- Create `server/mcp-user-entry.test.ts`.
- Modify `server/mcp-bridge.ts:171`: generalize `createGateInterceptor` to take a per-call verdict function.
- Modify `server/mcp-bridge.test.ts`.
- Modify `server/config.ts`: `mcpServers` in `AppConfig`, redacted on read.
- Modify `server/store.ts`: `BotRecord.mcpGrants`.
- Modify `server/contracts.ts`: `integrations.custom`, `capabilities.customMcp`.
- Modify `server/drivers/claude.ts`, `server/drivers/antigravity.ts`, `server/drivers/pi.ts`: mount `integrations.custom`; declare the capability.
- Modify `server/index.ts`: CRUD, probe, and grant endpoints.
- Create `src/components/McpServersPanel.tsx`, `src/components/McpServersPanel.test.ts`.
- Modify `src/components/PluginsPanel.tsx`: a second tab so Composio and direct MCP sit side by side.

---

### Task 1: The registry shape

**Files:**
- Create: `server/mcp-registry.ts`, `server/mcp-registry.test.ts`
- Modify: `server/config.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpStdioServer { transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  export interface McpHttpServer  { transport: "http"; url: string; headers?: Record<string, string> }
  export type McpServerConfig = (McpStdioServer | McpHttpServer) & { label?: string };
  export interface McpServerListing {
    name: string; transport: "stdio" | "http"; label?: string;
    command?: string; args?: string[]; url?: string;
    secretKeys: string[];              // names only, never values
    tools: McpToolListing[];           // last successful probe, empty before one
    probedAt?: number; probeError?: string;
  }
  export interface McpToolListing { name: string; description?: string }
  export function parseMcpServer(name: string, value: unknown): McpServerConfig | { error: string };
  export function isMcpServerName(name: string): boolean;
  export function redactServer(name: string, cfg: McpServerConfig, probe?: McpProbeRecord): McpServerListing;
  ```
- `isMcpServerName` uses the same rule as `isSkillName` (`server/skills.ts:41`): lowercase alphanumerics with single hyphens, 1–64 chars. That regex is the traversal gate — the name becomes a filename for the probe cache.

- [ ] Write failing tests: a valid stdio entry parses; a valid http entry parses; an `http://` URL that is not loopback is **rejected** (a remote MCP server reached without TLS would carry its bearer header in clear text); a `file://` or other scheme is rejected; an empty `command` is rejected; a name with a dot, slash, or uppercase is rejected.
- [ ] Write a failing test that `redactServer` returns `secretKeys: ["GITHUB_TOKEN"]` for `env: { GITHUB_TOKEN: "ghp_real" }` and that the serialized listing does not contain `ghp_real`. Same for HTTP `headers`.
- [ ] Write a failing test that an entry carrying an unknown extra key round-trips through parse and store rather than throwing.
- [ ] Run `pnpm vitest run server/mcp-registry.test.ts`; expect FAIL.
- [ ] Implement the module. Add `mcpServers: z.record(z.string(), mcpServerSchema).optional()` to `appConfigSchema` in `server/config.ts` and to `AppConfig`. Note the asymmetry: `appConfigPatchSchema` omits only `instances`, so `mcpServers` becomes **writable** automatically, while `GET /api/config` returns a hand-built `configStatus()` (`server/index.ts:4831`) and exposes nothing it is not explicitly told to. So the write path needs no wiring and the read path needs deliberate wiring — add `mcpServers` to `configStatus()` only as `redactServer` listings, never as `cfg.mcpServers`.
- [ ] Run; expect PASS.
- [ ] Commit `feat(mcp): user MCP server registry with redacted reads`.

---

### Task 2: Probe a server before trusting it

**Files:**
- Create: `server/mcp-probe.ts`, `server/mcp-probe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpProbeRecord { tools: McpToolListing[]; probedAt: number }
  export type McpProbeResult = { ok: true; probe: McpProbeRecord } | { ok: false; error: string };
  export function probeMcpServer(cfg: McpServerConfig, timeoutMs?: number): Promise<McpProbeResult>;
  ```
  Default timeout 10_000. The error string is for a human and must never contain a header value, an env value, or a raw provider error body.

- [ ] Write a failing test using a fake stdio MCP server script (follow the pattern of `server/testing/fake-acp-cli.ts`): probing returns the tool list from `tools/list`.
- [ ] Write a failing test that a server which never responds is abandoned at the timeout and returns `{ ok: false }` — not a hang. Assert the child process is killed, not merely orphaned.
- [ ] Write a failing test that a server which exits immediately, or writes non-JSON to stdout, returns a typed failure naming what went wrong.
- [ ] Write a failing test that the failure string for a server configured with `env: { TOKEN: "sekret" }` does not contain `sekret`, even when the child prints it to stderr.
- [ ] Run; expect FAIL.
- [ ] Implement: spawn (stdio) or `fetch` (http), send `initialize` then `tools/list`, resolve on the second response, and always tear down. Route the error string through `redactSecrets` (`server/redact.ts`) as a second line of defence.
- [ ] Run; expect PASS.
- [ ] Commit `feat(mcp): probe a server for its tool list before enabling it`.

---

### Task 3: Generalize the policy gate

**Files:**
- Modify: `server/mcp-bridge.ts:171-205` (`createGateInterceptor`)
- Modify: `server/mcp-bridge.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CallVerdict = { allow: true } | { allow: false; text: string };
  export function createGateInterceptor(options: {
    verdict: (toolName: string) => Promise<CallVerdict>;
    forward: (line: string) => void;
    refuse: (line: string) => void;
  }): (line: string) => void;
  ```
  The existing `isHeld`/`refusalText` callers (`server/container-mcp.ts`, `server/vps-container-mcp.ts`) migrate to `verdict: async () => (await isHeld()) ? { allow: false, text: CONTROL_REFUSAL_PLAIN } : { allow: true }`.

- [ ] Write a failing test: a `tools/call` for a tool the verdict function denies is answered with a JSON-RPC error result carrying the verdict's text, and is **not** forwarded to the child.
- [ ] Write a failing test that the existing who-is-driving behaviour is unchanged — the migrated callers still refuse every call while the hold is held.
- [ ] Write a failing test that non-`tools/call` frames and unparseable lines are forwarded untouched, and that ordering is preserved across an async verdict (the existing `queue` chain must survive the refactor). This is the property most likely to break: two rapid calls where the first verdict resolves slower than the second must still reach the child in order.
- [ ] Run `pnpm vitest run server/mcp-bridge.test.ts`; expect FAIL.
- [ ] Refactor `createGateInterceptor` to the verdict signature, keeping the serialized `queue` exactly as it is. Migrate both existing callers in the same commit — a partial migration leaves two gate shapes in the tree.
- [ ] Run `pnpm vitest run server/`; expect PASS including the container and VPS suites.
- [ ] Commit `refactor(mcp): gate interceptor takes a per-tool verdict`.

---

### Task 4: The bridge entry point

**Files:**
- Create: `server/mcp-user-entry.ts`, `server/mcp-user-entry.test.ts`

**Interfaces:**
- Consumes: `McpServerConfig` (Task 1), `createGateInterceptor` (Task 3), `runMcpBridge` (`server/mcp-bridge.ts:208`).
- Produces: a process spawned as `node mcp-user-entry.ts <serverName>`, reading its definition and its allowlist from env — `OMB_MCP_SERVER` (JSON definition) and `OMB_MCP_ALLOW` (comma-separated tool names, or `*`).

- [ ] Write a failing test: with `OMB_MCP_ALLOW="read_file"`, a `tools/call` for `read_file` reaches the fake child and a call for `write_file` is refused with a message naming the tool and saying it is not granted to this bot.
- [ ] Write a failing test that `OMB_MCP_ALLOW="*"` forwards everything, and that an **absent** `OMB_MCP_ALLOW` refuses everything. Default-deny: a bridge started without a policy must not become a bridge with no policy.
- [ ] Write a failing test that the definition rides in **env, not argv** — assert the spawn arguments contain no token. `server/container-mcp.ts:20` already establishes this rule: argv is world-readable through `ps`.
- [ ] Write a failing test that an HTTP server's responses are relayed to stdout unchanged and that its `headers` never appear in the bridge's own stderr.
- [ ] Run; expect FAIL.
- [ ] Implement: parse and validate the env definition (reject rather than run on a malformed one), build the verdict function from the allowlist, and hand off to `runMcpBridge` for stdio or a small `fetch` relay loop for http. Reuse `createLineSplitter` (`server/mcp-bridge.ts:141`) for the http path rather than writing a second splitter.
- [ ] Run; expect PASS.
- [ ] Commit `feat(mcp): harness-owned bridge for user MCP servers`.

---

### Task 5: Per-bot grants

**Files:**
- Modify: `server/store.ts` (`BotRecord`)
- Modify: `server/index.ts`
- Test: `server/index.test.ts`

**Interfaces:**
- Produces: `BotRecord.mcpGrants?: Record<string, string[]>` — server name to granted tool names, `["*"]` for all. Absent or empty means no access, matching the default-deny in Task 4.
- Produces: `GET/POST/DELETE /api/mcp/servers`, `POST /api/mcp/servers/:name/probe`, `PUT /api/bots/:id/mcp-grants`.

- [ ] Write a failing API test: `POST /api/mcp/servers` stores a server and the subsequent `GET` returns it with `secretKeys` but no values.
- [ ] Write a failing API test that a newly added server has **no grants on any bot** — the list endpoint shows it enabled nowhere. Adding a server must not connect it to anything.
- [ ] Write a failing API test that `POST .../probe` returns the tool list and that a later `GET` carries the cached `tools` and `probedAt`.
- [ ] Write a failing API test that `PUT /api/bots/:id/mcp-grants` rejects a grant naming a server that does not exist, and rejects a tool name that the last successful probe did not list — granting a tool nobody has ever seen is how a typo becomes a silent no-op.
- [ ] Write a failing API test that deleting a server clears its grants from every bot. A dangling grant that springs back to life when a name is reused is a real hazard.
- [ ] Run; expect FAIL.
- [ ] Implement the routes. Grants live on `BotRecord` so they travel with `store.saveBots()` and appear in the P2 profile document; add `connectors.mcp` to `BotProfileDocument` if P2 has landed, otherwise leave a one-line note in `server/profile-document.ts` for whoever lands it second.
- [ ] Run; expect PASS.
- [ ] Commit `feat(mcp): per-bot server and tool grants`.

---

### Task 6: Mount it on the drivers

**Files:**
- Modify: `server/contracts.ts:161` (`integrations`), `:205` (`capabilities`)
- Modify: `server/drivers/claude.ts:562-631`, `server/drivers/antigravity.ts:214`, `server/drivers/pi.ts:321`
- Modify: `server/index.ts` (turn assembly, near the existing integration wiring)
- Test: `server/drivers/claude.test.ts`, `server/drivers/antigravity.test.ts`

**Interfaces:**
- Produces: `integrations.custom?: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }>` — already bridged, so every driver mounts it identically to the existing `composio` entry.
- Produces: `capabilities.customMcp?: boolean`.

- [ ] Write a failing test in `server/drivers/claude.test.ts`: a turn carrying two `integrations.custom` entries writes both into the CLI's `mcpServers` config alongside the harness's own, without colliding with the reserved names `composio`, `computer`, `agents`, `phone`, `dweb`, `ogb`. Assert a user server named `computer` is namespaced rather than overwriting the real one — this is the collision that would silently disarm the computer gate.
- [ ] Write a failing test that `argsKey` at `server/drivers/claude.ts:642` includes the custom entries, so changing a grant invalidates the cached session rather than silently reusing a process started under the old policy.
- [ ] Write a failing test in `server/drivers/antigravity.test.ts` that harness-provided custom servers merge with the user's own pre-existing config file entries and win on a name collision.
- [ ] Run; expect FAIL.
- [ ] Add the contract fields. In `server/index.ts`, build `integrations.custom` from `bot.mcpGrants` × the registry, spawning each through `mcp-user-entry.ts` with `OMB_MCP_SERVER` and `OMB_MCP_ALLOW` set. Declare `customMcp: true` on claude, antigravity, and pi; leave it absent everywhere else.
- [ ] Run `pnpm vitest run server/drivers/`; expect PASS.
- [ ] Commit `feat(mcp): mount user MCP servers on the drivers that can hold them`.

---

### Task 7: The Connections Center UI

**Files:**
- Create: `src/components/McpServersPanel.tsx`, `src/components/McpServersPanel.test.ts`
- Modify: `src/components/PluginsPanel.tsx`

- [ ] Write a failing test for the pure form validator: `validateServerForm` accepts a stdio form with a command, accepts an https URL, rejects a bare `http://example.com`, rejects an empty name, and reports the field at fault.
- [ ] Run; expect FAIL.
- [ ] Implement the panel: an add form for stdio and remote, a **Test connection** button that calls the probe route and renders the returned tools, and a per-bot grant editor listing each probed tool with a checkbox. A server with no successful probe cannot be granted — the grant UI stays disabled with the probe error shown.
- [ ] Show where each server runs: stdio entries say "on this computer", http entries show the origin. That is the community's "show where the connector runs and where data travels" ask, and it is one line of honest text per row rather than a feature.
- [ ] Restructure `PluginsPanel.tsx` into two tabs — "Apps" (the existing Composio catalog, unchanged) and "MCP servers" (this panel). Do not move the Composio code; wrap it.
- [ ] Run the focused test, `pnpm typecheck`, `pnpm check:contrast`.
- [ ] Commit `feat(mcp): connections center with direct MCP servers`.

---

## Self-review

**Coverage against the community's Connections Center list.** Curated catalog — already
exists (`/api/connectors/catalog`). Add local stdio and remote HTTP — Tasks 1, 4, 7.
Test before enabling — Task 2. Discover and enable individual tools — Tasks 2, 5, 7.
Permissions per bot — Task 5. Show where it runs — Task 7. **Guided OAuth for direct MCP
servers is not covered** and is deliberately out of scope: OAuth-per-MCP-server needs a
callback listener and a token store, which is its own plan. Bearer headers cover the
common remote case today.

**Type consistency.** `McpServerConfig` (Task 1) is what Task 2 probes, Task 4 runs, and
Task 5 stores. `McpToolListing` is produced by Task 2 and consumed by Tasks 5 and 7.
`CallVerdict` (Task 3) is produced only by Task 4's allowlist function.

**Sequencing risk.** Task 3 refactors a module two existing entry points depend on. It
must land as one commit including both migrations, and `pnpm vitest run server/` must be
green before Task 4 starts — Task 4's tests will otherwise fail for a reason that has
nothing to do with Task 4.
