# Lent MCP: streams and consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move My Cloud's calls to MCP servers on a lent computer off the one-job queue onto device-link streams, and make the computer ask its person once per server before it reaches or runs one.

**Architecture:** A (main) keeps its surface in `server/lent-mcp.ts` and `electron/computer-sharing.mjs`; a second path is chosen per computer from its registration's `mcp` field. On My Cloud the existing internal route replays HTTP onto a link stream (URL server) or speaks Streamable HTTP to a per-thread stdio session over a stream (command server). On the computer a door (`electron/device-mcp.mjs`, from B) answers each open from its own approvals and a native prompt. Older computers keep the job path.

**Tech Stack:** Node 24, TypeScript (`server/`), ESM JavaScript (`electron/`), vitest, `node --test`, zod, `ws`.

**Spec:** `docs/superpowers/specs/2026-11-07-lent-mcp-streams-consent-design.md`

**Base:** `origin/main` at 1bc4749aa, branch `feat/lent-mcp-streams-consent`, with `origin/fix/lent-mcp-own-ports` (#4744: `ownPorts`, `onItsOwnPort`, the `port` LentState) and `origin/fix/lent-mcp-no-computer` (#4745: `place()` refuses with none lent) already merged in (c7882ef29). Keep their tests green; nothing here undoes them.

**Controller rulings** are recorded in `.superpowers/sdd/2026-11-07-lent-mcp-streams-consent/progress.md` and already written into the task text below; where the spec's Goal says a command server's child lives "between turns", Ruling 4 amends it to one child per engine session, the thread's next turn ending the previous turn's.

## Global Constraints

- Node 24 on PATH for every command: `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"` (the default shell has Node 22).
- Before each commit: `pnpm typecheck` and `pnpm lint` pass; `pnpm vitest run scripts/testing/file-size-ratchet.test.ts` passes with no number in `LINES` raised. `server/index.ts` (15636) and `electron/main.mjs` (3232) are pinned: change them only on existing lines, never add a line.
- New wiring goes in `server/host/` factories or the module it belongs to, never in `server/index.ts`.
- Every new UI string key goes in all 16 packs under `src/locales/` (de, en, es, fr, hi, it, ja, ko, pl, pt-br, ru, tr, uk, vi, zh-tw, zh), then `node scripts/generate-locale.mjs --record-hashes` (records hashes for new keys only) and `node scripts/generate-locale.mjs --check` passes. Never change the English of an existing key (its recorded hashes would go stale) and never edit `source-hashes.json` by hand. `electron/lending-words.mjs` keeps its own 16 inline packs: a key added there goes in each.
- No commit leaves a test red: each task's verify commands include every existing test file its change can break.
- Comments follow `AGENTS.md`: only what the code cannot say; a security invariant gets a `Security:` line; no history, no PR numbers, no pointers at other files.
- Cross-platform: the lent computer may be Windows (`taskkill /T /F`, `windowsLaunch`, "this computer" wording). No phone changes.
- Verification runs against isolated fixtures (temp data dirs, temp homes, loopback ports from `server/testing/ports.ts`), never the live app (`docs/verification/README.md`).
- Reuse B's code where it fits (worktree `/Users/omkar/Desktop/openmaus/OpenGrokBot-cloud-local-mcp`, branch `feat/cloud-local-mcp`, HEAD fcef6de7e): copy, then adapt to the signatures below. B's reviewed lessons stand: `LinkEnd` instead of Node's `duplexPair`; declines held per target as well as per name; `url()` keeps a thread's sessions; a URL server's saved headers travel with its requests.
- Plain-words lines for the bot never carry an env or header value, a command's secret-looking args, or child stderr.

## Review Focus

1. The engine POSTs a `tools/call` while the computer's prompt is up: a reasonable person expects a readable "waiting for Allow on <Mac>" result, not an HTTP 502. Test: Task 4 `route answers a refused open as the bot reads it`.
2. The old SSE transport: the server's `endpoint` event names a path at its own root, and the client POSTs there; through a prefixed door those POSTs miss. Test: Task 3 `an SSE endpoint event is re-prefixed`.
3. A person turns "Your MCP servers" off while a child runs on the computer: they expect the child to stop. Test: Task 7 `turning the switch off ends the link, forgets approvals and ends every child`.
4. The definition on My Cloud changes (new args) after the person allowed the old one: the computer must not run the new one under the old Allow. Test: Task 6 `a changed definition under an old approval asks again and runs nothing`.
5. An older computer (no `mcp` in its registration) after My Cloud updates: its servers must keep working through jobs, and a newer computer with the switch off must never be served by jobs. Test: Task 5 `an older computer keeps the job path; a computer that sent mcp is never served by jobs`.

---

### Task 1: Registration, link routing and the open frame

**Files:**
- Modify: `server/shared-computers.ts` (registration, `register`, `runsOn`, `linkable`, `sharedComputerScopeRefusal`)
- Modify: `server/device-links.ts` (`LinkedComputer`, `mcpRoute`, one `newestLink` helper)
- Modify: `electron/device-link-protocol.mjs`, `electron/device-link-protocol.d.mts` (open frame)
- Modify: `electron/device-link.mjs`, `electron/device-link.d.mts` (`runDeviceLink`'s `mcp` option, `lends().mcp`)
- Modify: `server/environment.ts` (capability `lentMcpLink`)
- Test: `server/shared-computers.test.ts` (new tests, and the `runsOn` `toEqual` at :475), `server/device-links.test.ts`, `electron/device-link.node-test.mjs`, `server/environment.test.ts` (new test, and the capabilities `toEqual` at :141), `server/lent-mcp.test.ts` (only its typed `runsOn` fixture at :18 gains `mcpLink: null`)

**Interfaces:**
- Produces: registration field `mcp?: boolean`; `runsOn().online.mcpLink: boolean | null`; `LinkedComputer.id: string; mcp: boolean`; `DeviceLinks.mcpRoute(person: string, computerId: string): McpRoute | null` with `McpRoute = { open(target: McpOpen): Promise<LinkOpened> }`; `McpOpen = { name: string; port: number } | { name: string; fingerprint: string }`; `LinkMux.open({ mcp: McpOpen })`; the computer's `accept` receives `{ mcp: McpOpen }`; `runDeviceLink({ …, mcp?: { open(target: McpOpen): Promise<{ socket: Duplex } | { refused: string } | { failed: string }> } })` and `lends(): { internet, chrome, mcp }`; `capabilities.lentMcpLink?: true`.

- [ ] **Step 1: Write the failing tests**

```ts
// server/shared-computers.test.ts
it("mcp in a registration reaches runsOn as mcpLink, null for an older computer, and a change drops the link", () => {
  // register with { mcpServers: true, environments: [ENV] } → runsOn(...).online.mcpLink === null
  // re-register with mcp: true → mcpLink === true; links.drop called once with the computer's key
  // re-register with mcp: false → mcpLink === false
});
it("an mcp_tools job is refused for a computer that sent mcp", () => {
  expect(sharedComputerScopeRefusal({ ...reg, mcpServers: true, mcp: true }, { action: "mcp_tools", server })).toMatch(/through its link/);
  expect(sharedComputerScopeRefusal({ ...reg, mcpServers: true }, { action: "mcp_tools", server })).toBeNull();
});
// server/device-links.test.ts
it("mcpRoute picks the newest open link of that computer that lends mcp, and opens { mcp: target }", async () => { /* two links, one mcp:false → null for it; frame sent is {t:"open", id, mcp:{name:"local", port:19501}} */ });
// electron/device-link.node-test.mjs
test("an open with mcp reaches accept as { mcp: { name, port } } and { mcp: { name, fingerprint } }", ...);   // fingerprint survives openTarget
test("an mcp open is refused not-lent unless lends().mcp, and otherwise goes to the mcp door", ...);
// server/environment.test.ts
it("advertises lentMcpLink only on a personal Cloud home with lending", ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run server/shared-computers.test.ts server/device-links.test.ts server/environment.test.ts && node --test electron/device-link.node-test.mjs`
Expected: FAIL (unknown field `mcp`, `mcpRoute` undefined, `lentMcpLink` absent).

- [ ] **Step 3: Implement**

- `sharedComputerRegistration`: add `mcp: z.boolean().optional()` with a doc comment ("It takes MCP streams over its link and lends them (`true`) or not (`false`); sent only to a server that advertises lentMcpLink").
- `register()`: include `(old.registration.mcp === true) !== (registration.mcp === true)` in the drop condition.
- `runsOn()`: `online.mcpLink = entry.registration.mcp ?? null`.
- `linkable()`: return `id`, `mcp: entry.registration.mcp === true`.
- `sharedComputerScopeRefusal` for `mcp_tools`/`mcp_call`: before the terminal check, `if (registration.mcp !== undefined) return \`${registration.name} runs MCP servers for this server through its link, not as a job.\`` with a `// Security:` line that the job path is never a way around the computer's switch.
- `DeviceLinks.mcpRoute(person, computerId)`: extract the newest-open-link loop and `usedAt` stamping that `route` and `chromeRoute` repeat into one private `newestLink(person, wanted: (computer) => boolean)` and use it in all three; `mcpRoute` wants `computer.id === computerId && computer.mcp` and opens `{ mcp: target }`.
- `device-link-protocol.mjs`: B's `openTarget` and `open()` control branch for `target.mcp`, carrying `name` and exactly one of `port` (integer) or `fingerprint` (string); `.d.mts` `open(target: { host; port } | { chrome: true } | { mcp: McpOpen })`.
- `device-link.mjs` (from B's diff on that file): `runDeviceLink`'s `mcp: { open }` option; an `mcp` open is refused `not-lent` unless `lends().mcp === true`, else handed to `mcp.open(target)`; `.d.mts` to match.
- `environment.ts`: `lentMcpLink: true as const` under the `myChromeLink` condition; add to the capabilities type.
- Existing assertions that change: `shared-computers.test.ts:475` (`runsOn` now has `mcpLink`), `environment.test.ts:141` (capabilities gain `lentMcpLink`), and the typed fixture in `server/lent-mcp.test.ts:18` (add `mcpLink: null`, nothing else in that file).

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2, plus `pnpm vitest run server/lent-mcp.test.ts && pnpm typecheck && pnpm lint`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/shared-computers.ts server/shared-computers.test.ts server/device-links.ts server/device-links.test.ts electron/device-link-protocol.mjs electron/device-link-protocol.d.mts electron/device-link.mjs electron/device-link.d.mts electron/device-link.node-test.mjs server/environment.ts server/environment.test.ts server/lent-mcp.test.ts
git commit -m "feat(cloud): a lent computer's registration says whether it lends MCP over its link, and the link opens MCP streams"
```

---

### Task 2: Stdio sessions over a link stream

**Files:**
- Create: `server/lent-mcp-stdio.ts` (copy B's `server/lent-mcp-stdio.ts`, then the two changes below)
- Create: `server/testing/stdio-mcp-child.ts` (copy B's; the test imports it)
- Test: `server/lent-mcp-stdio.test.ts` (copy B's, plus the two tests below)

**Interfaces:**
- Produces: `class LinkEnd extends Duplex { static pair(): [LinkEnd, LinkEnd] }`; `class StdioSessions { constructor(deps: { open(): Promise<LinkOpened>; idleMs: number; now?(): number; sweepMs?: number; onEmpty?(): void }); get size(): number; handle(req: IncomingMessage, res: ServerResponse): Promise<"opened" | { refused: Exclude<LinkOpened, LinkStream>; messages: unknown[] } | void>; drop(): void; close(): void }`.

- [ ] **Step 1: Copy B's test file and the child fixture, add the two tests, and run to verify they fail**

```ts
it("a refused initialize comes back with the parsed messages, so the caller answers without reading the body again", async () => {
  // open → { refused: "needs-approval" }; POST [initialize id 1] → handle resolves { refused: { refused: "needs-approval" }, messages: [{ jsonrpc: "2.0", id: 1, method: "initialize", … }] }; res untouched
});
it("onEmpty runs once the last session ends, by DELETE or by the idle sweep", ...);
```

Run: `pnpm vitest run server/lent-mcp-stdio.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Copy B's module, then change two things**

`createLineSplitter` comes from `server/mcp-bridge.ts` (exists on main). Keep B's comment on why `LinkEnd` exists (a Node 24.14.1 `duplexPair` fact) and the `Security:` line on session ending.
1. `handle()` returns `{ refused: opened, messages }` (the parsed messages) where B returned the bare refusal.
2. `#end` calls `deps.onEmpty?.()` when it removes the last session.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm vitest run server/lent-mcp-stdio.test.ts`. Expected: PASS, 10 tests.

- [ ] **Step 4: Commit**

```bash
git add server/lent-mcp-stdio.ts server/lent-mcp-stdio.test.ts server/testing/stdio-mcp-child.ts
git commit -m "feat(cloud): serve a stdio MCP child on a link stream as Streamable HTTP"
```

---

### Task 3: HTTP replay onto a link stream, with the SSE endpoint re-prefixed

**Files:**
- Create: `server/lent-mcp-link.ts`
- Test: `server/lent-mcp-link.test.ts`

**Interfaces:**
- Consumes: `LinkEnd` (Task 2), `LinkOpened`/`LinkStream` types.
- Produces:
  - `export function replayPath(url: string, prefix: string, saved: { path: string; query: string }): string | null` — `url` is the request's raw `req.url` (path and query). `prefix` itself (optionally followed by `?…`) → `saved.path + saved.query`; `${prefix}/<rest>` → `/<rest>` plus the request's own query; anything else → null.
  - `export function replayHttp(req: IncomingMessage, res: ServerResponse, opened: LinkStream, target: { port: number; path: string; prefix: string; headers: Record<string, string> }): void` — B's `#serve` URL branch: `http.request({ createConnection: () => ours, method, path: target.path, headers })` where `headers` is the request's headers without `authorization`, `host` and `connection`, then `target.headers` (the saved server's own headers), then `host: \`127.0.0.1:${port}\`` and `connection: "close"`, with a `// Security:` line that the turn bearer never leaves My Cloud. Response headers minus `connection`, `flushHeaders()`, `pipeline(answer, res)`; when the answer is `text/event-stream`, pass it through a Transform that rewrites each `event: endpoint` data line (an absolute path, or a full URL) to `${target.prefix}${pathname}${search}`.
  - The bot-facing words for a refused open are Task 4's (`lentLine`, `linkProblem`), not this module's.

- [ ] **Step 1: Write the failing tests** (fake server on a loopback port joined by `LinkEnd.pair()`; B's `server/lent-mcp-doors.test.ts` has the harness to copy)

```ts
it("a request is replayed with the saved headers, Host rewritten and Connection close, and the engine's authorization never sent", async () => {
  // request carries authorization "Bearer turn-token"; target.headers { authorization: "Bearer mac-header-key", "x-api-key": "k" }
  // fake server sees authorization "Bearer mac-header-key", x-api-key "k", host "127.0.0.1:<port>", connection "close"; never "turn-token"
});
it("SSE streams through and Connection: close is not passed on", ...);
it("an SSE endpoint event is re-prefixed", async () => {
  // fake server answers `event: endpoint\ndata: /messages?sessionId=1\n\n`, then again with `data: http://127.0.0.1:<port>/messages?sessionId=2`;
  // client under prefix "/api/internal/lent/mcp/local" sees "/api/internal/lent/mcp/local/messages?sessionId=1" and "…/messages?sessionId=2"
});
it("replayPath maps the bare door to the saved path and query, a sub-path to the server root with its own query, and anything else to null", () => {
  expect(replayPath("/api/internal/lent/mcp/local", "/api/internal/lent/mcp/local", { path: "/mcp", query: "?a=1" })).toBe("/mcp?a=1");
  expect(replayPath("/api/internal/lent/mcp/local/messages?sessionId=1", "/api/internal/lent/mcp/local", { path: "/mcp", query: "" })).toBe("/messages?sessionId=1");
  expect(replayPath("/api/internal/lent/mcp/localx", "/api/internal/lent/mcp/local", { path: "/mcp", query: "" })).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run server/lent-mcp-link.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `server/lent-mcp-link.ts`** as above.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cloud): replay a URL MCP server's requests onto a lent computer's link stream"`

---

### Task 4: `server/lent-mcp.ts` takes the stream path

**Files:**
- Modify: `server/lent-mcp.ts` (`LentMcpDeps`, `lentState`, `lentLine`, `linkProblem`, `mounts`, `route`, `test`, `definition`, `close`)
- Modify: `electron/lent-mcp.mjs`, `electron/lent-mcp.d.mts` (add the exported `commandFingerprint`; nothing else there changes in this task)
- Modify: `server/shared-computers.ts` (a public check of a computer's id and secret, the same one the `lease` route uses)
- Modify: `server/routes/shared-computers.ts` (the `mcp-server` definition route)
- Modify: `server/index.ts:2842` (add `links: deviceLinks` to `createLentMcp({...})` on that line), `server/index.ts:12120` (pass `lentMcp` to `createSharedComputerRoutes` on that line) and `server/index.ts:15572` (call `lentMcp.close()` on the existing `sharedComputers.close()` line)
- Create: `server/testing/fake-stdio-mcp.mjs` (copy B's)
- Test: `server/lent-mcp.test.ts`, and the mcp-server route test beside the existing `lease` route test (find it with `grep -rn "/lease" server/*.test.ts`), `electron/lent-mcp.node-test.mjs` (one `commandFingerprint` test)

**Interfaces:**
- Consumes: `mcpRoute`, `runsOn().online.mcpLink` (Task 1), `StdioSessions`/`LinkEnd` (Task 2), `replayHttp`/`replayPath` (Task 3), `ownPorts`/`onItsOwnPort` and the `port` LentState (#4744, already merged).
- Produces:
  - `LentMcpDeps.links: Pick<DeviceLinks, "mcpRoute">`.
  - `LentState` ready: `{ kind: "ready"; computerId: string; link: boolean; computer: string; device }`; new non-ready kind `not-lending`.
  - `lentState`: `online.mcpLink === false` → `not-lending`; otherwise the `outdated` and `port` rules as today on both paths; `no-terminal` only when `online.mcpLink === null`; ready carries `link: online.mcpLink === true`.
  - `export type LentProblem = "not-lending" | "needs-approval" | "declined" | "no-server" | "changed" | "unreachable"`.
  - `lentLine(name, state: Exclude<LentState, { kind: "ready" }> | { kind: LentProblem; computer: string; device }, words)` — the one function for every bot-facing line, so the new kinds use its existing `theirs` ("your Mac (Ada's Mac)" when personal, else "Ada's Mac"). New texts:
    - not-lending: `${name} runs on ${theirs}, which isn't lending its MCP servers to ${place}: turn on "Let My Cloud use your MCP servers on this ${device}" from the OpenMausBot icon on that ${device}.`
    - needs-approval: `Allow ${name} on ${theirs}: a prompt is waiting there. Then try again.`
    - declined: `On ${theirs}, the person didn't allow ${name}. Ask them before trying again.`
    - no-server: `${theirs} has no definition of ${name} to run.` (capitalise the first letter when `theirs` starts with "your")
    - changed: `${name} changed since the person allowed it on ${theirs}: a new prompt is waiting there.`
    - unreachable: `${name} on ${theirs} didn't answer. Check that it is running there.`
  - `export function linkProblem(opened: Exclude<LinkOpened, LinkStream> | null): "offline" | LentProblem` — null (no open link) → `offline` (the existing offline text); `refused: "not-lent"` → `not-lending`; `refused: "needs-approval" | "declined"` → itself; `failed: "no-server" | "changed"` → itself; any other refusal or failure (`bad-port`, `busy`, `timeout`, `spawn-failed`, `gone`) → `unreachable`.
  - `commandFingerprint({ command, args, env }): string` in `electron/lent-mcp.mjs` — sha256 hex of `JSON.stringify([command, args, Object.keys(env).sort()])`; the server and (Task 6) the computer's door both import this one function.
  - `createLentMcp(deps)` additionally returns `definition(principal: string, computerId: string, name: string): LentMcpServer | null` (a command server of that principal whose `runsOn` names that computer, as `lentDefinition`; null for a URL server or none) and `close(): void` (ends every session).
  - `route()` on the stream path accepts GET, POST, DELETE.
  - `test()` unchanged signature.

- [ ] **Step 1: Write the failing tests** (extend `server/lent-mcp.test.ts` with a fixture whose `computers.runsOn` returns `mcpLink: true` and whose `links.mcpRoute` returns a fake route backed by `LinkEnd.pair()` and a fake HTTP MCP server / a fake stdio child from `server/testing/fake-stdio-mcp.mjs`)

```ts
it("a computer that lends mcp is reached over its link: tools/list and tools/call for a URL server go through with its saved headers, no job is queued", ...);
it("a command server gets one stdio session per engine session; the thread's next turn initializing it ends the previous turn's; DELETE ends one; an emptied thread leaves the map", ...);
it("route answers a refused open as the bot reads it", async () => {
  // mid-session (request carries a real Mcp-Session-Id or is not an initialize): route.open → { refused: "needs-approval" }; POST tools/call → 200 with result.isError and text "Allow local on your Mac (Ada's Mac): a prompt is waiting there. Then try again."
  // route.open → { refused: "declined" }; POST tools/list → jsonrpc error with "On your Mac (Ada's Mac), the person didn't allow local. Ask them before trying again."
});
it("a refused initialize is answered on My Cloud with the line as instructions, and that session is answered here without opening", async () => {
  // route.open → { refused: "needs-approval" }; POST initialize → 200, result.instructions is the needs-approval line, header mcp-session-id "refused-needs-approval"
  // with that session id: tools/list → { tools: [] }; tools/call → isError with the line; notifications/initialized → 202; DELETE → 200; route.open was called once in all
  // the same for a command server (StdioSessions returns { refused, messages })
});
it("a computer with the switch off is not-lending: mounts leaves it out, lines says so, nothing is opened", ...);
it("the port rule holds on the link path too, and no-terminal only on the job path", ...);
it("a URL server on the old SSE transport mounts with type sse on the link path; a job-path computer still mounts it as http", ...);
it("a request after the turn ended is refused without opening", ...);
it("test on the stream path probes the server through an ephemeral loopback door that answers 404 without its token, and reports the open's problem", ...);
it("definition serves a command server's definition for its own computer and nothing for a URL server or another computer", ...);
it("an older computer (mcpLink null) still takes the job path", ...);   // A's existing tests keep passing
// beside the lease route test
it("POST /api/shared-computers/:id/mcp-server answers the definition only with that computer's secret, and { server: null } for none", ...);
// electron/lent-mcp.node-test.mjs
test("commandFingerprint hashes command, args and env names, never env values", ...);   // same for env values "a" and "b"; differs when an arg changes
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run server/lent-mcp.test.ts <the lease route test file>` and `node --test electron/lent-mcp.node-test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `route()`: name is the first path segment after `LENT_MCP_PATH`. `if (state.link)` → check `deps.active(ctx.turn)` (refuse 401 without opening when not), then `serve(ctx.req, ctx.res, { name, server, state, turn: ctx.turn, prefix: LENT_MCP_PATH + name })`; else A's `rpc()` as today (the POST-only check moves inside the job branch).
- Requests whose `mcp-session-id` starts with `refused-` are answered on My Cloud before anything opens (Ruling 5): tools/list `{ tools: [] }`, tools/call `callError(line)`, ping `{}`, other requests `rpcError(line)`, notifications 202, DELETE 200, GET 405, with the line from `lentLine(name, { kind: <problem in the id>, … })` (an unknown problem → `unreachable`).
- `serve()`: URL server → `route.open({ name, port })` before reading anything; a stream → `replayHttp(req, res, opened, { port, path: replayPath(req.url, prefix, saved), prefix, headers: server.headers ?? {} })` (null path → 404). Command server → the thread's sessions (below), then `handle(req, res)`.
- One answering function for a refused or failed open, used by both kinds: the messages (URL: `ctx.readBody()`, which nothing has read yet; command: `handle()`'s `messages`); an `initialize` among them → 200 with A's initialize result plus `instructions: line` and header `mcp-session-id: refused-<problem>`; otherwise each request gets `callError(line)` for tools/call or `rpcError(line)`; only notifications → 202. `line = lentLine(name, { kind: linkProblem(opened), computer, device }, words)`.
- Sessions: a map keyed `${threadId}\n${name}` holding `{ generation, sessions: StdioSessions }`, built with `open: () => route.open({ name, fingerprint: commandFingerprint(lentDefinition(name, server)) })`, `idleMs: 600_000`, `onEmpty` removing that entry. A request without a session id from a different generation than the entry's closes the entry and builds a new one. A request for a computer whose `computerId` differs from the entry's closes it. `close()` closes every entry.
- `test()`: `http.createServer` on `127.0.0.1:0` whose handler answers 404 unless the path is `/${token}` or starts with `/${token}/`, then calls `serve` with `prefix: \`/${token}\`` and a fresh test turn; probe `{ type: server.type ?? "http", url: \`http://127.0.0.1:${port}/${token}\`, headers: {} }` with `probeMcpServer` (the door adds the saved headers); record the last problem of that turn; close the server and its sessions in `finally`; a problem's line wins over the probe's generic error text.
- `mounts()`: `type: state.link && isRemoteMcpServer(server) ? server.type : "http"`.
- `definition()` and the route in `server/routes/shared-computers.ts` beside `poll|lease|result|disconnect`: `mcp-server` → `json(res, 200, { server: definition ?? null })`; authorization identical to `lease`, through the new public check on `SharedComputers` (it is private today).

- [ ] **Step 4: Run to verify they pass** — Step 2's commands plus `pnpm vitest run server/cloud-lent-mcp.e2e.test.ts server/routes/internal-mcp.test.ts server/routes/mcp-servers.test.ts server/host/mcp-config.test.ts server/device-links.test.ts server/shared-computers.test.ts` (A's e2e: the real connector does not send `mcp` yet, so the job path must still pass end to end). Expected: PASS.
- [ ] **Step 5: `pnpm typecheck && pnpm lint && pnpm vitest run scripts/testing/file-size-ratchet.test.ts`** — Expected: clean; `server/index.ts` line count unchanged.
- [ ] **Step 6: Commit** — `git commit -m "feat(cloud): reach a lent computer's MCP servers over its link, side by side and with the whole protocol"`

---

### Task 5: My Cloud end to end through a real link pair, and the migration test

**Files:**
- Create: `server/lent-mcp-link.e2e.test.ts` (from B's `server/lent-mcp.e2e.test.ts`, adapted)
- Modify: `server/cloud-lent-mcp.e2e.test.ts` (migration case)

**Interfaces:**
- Consumes: `DeviceLinks` + `runDeviceLink` with its `mcp: { open }` option and `lends().mcp` (Task 1) over a real `ws` server, `createLentMcp` (Task 4) with a stub door on the computer side (Task 6 builds the real one), the fixtures `server/testing/fake-stdio-mcp.mjs` (Task 4) and `server/testing/stdio-mcp-child.ts` (Task 2).

- [ ] **Step 1: Write the tests**

```ts
// server/lent-mcp-link.e2e.test.ts — real DeviceLinks on a ws server, real runDeviceLink client, stub door
it("two tools/call to one server run side by side over one link", ...);   // first call blocks 2 s in the fake server; second answers first
it("a command server's child lives between calls and ends on DELETE; its stderr never reaches My Cloud", ...);
it("server-sent notifications reach the engine's GET stream", ...);
it("not-lent, needs-approval and declined from the door become the bot's plain words", ...);   // including a refused initialize answered with instructions
it("an old-SSE server's endpoint POSTs come back through the door", ...);
it("no env value, header value or child stderr appears in any link control frame", ...);   // capture frames at the ws server; assert none contains "mac-env-key"/"mac-header-key"
// server/cloud-lent-mcp.e2e.test.ts
it("an older computer keeps the job path; a computer that sent mcp is never served by jobs", async () => {
  // hand-rolled poller: POST connect with { mcpServers: true, environments } and no mcp; answers mcp_tools jobs → tools listed
  // then connect again with { mcp: false }: test says "isn't lending its MCP servers"; poll receives no mcp_tools job within 3 s
});
```

- [ ] **Step 2: Run** — `pnpm vitest run server/lent-mcp-link.e2e.test.ts server/cloud-lent-mcp.e2e.test.ts`. Expected: PASS.
- [ ] **Step 3: Commit** — `git commit -m "test(cloud): MCP over a real link pair, and an older computer keeps the job path"`

---

### Task 6: The computer's MCP door

**Files:**
- Create: `electron/device-mcp.mjs`, `electron/device-mcp.d.mts` (from B, adapted)
- Modify: `electron/lent-mcp.mjs`, `electron/lent-mcp.d.mts` (export `killTree(child, { platform, spawn })`; the job client stays until Task 7)
- Test: `electron/device-mcp.node-test.mjs` (from B, adapted), `electron/lent-mcp.node-test.mjs` (the job client's tests keep passing with the new `killTree` signature)

**Interfaces:**
- Consumes: `ownPorts` (#4744), `commandFingerprint` (Task 4), `windowsLaunch`, `inheritedEnvironment` (all in `electron/lent-mcp.mjs`), `commandPath()` (`electron/shell-path.mjs`).
- Produces:
  - `export function killTree(child, { platform = process.platform, spawn = <the module's spawn> } = {}): void` in `electron/lent-mcp.mjs` — the one way a lent child's process tree is ended (`taskkill /pid <pid> /T /F` on win32, the process group otherwise); the job client and the door both call it.
  - `export function shownCommand(command: string, args: string[]): string` (B's).
  - `export type McpApproval = { kind: "url"; port: number } | { kind: "command"; fingerprint: string }`.
  - `export function createMcpDoor({ approvals: { read(): Record<string, McpApproval>; write(next): void }, prompt(ask: { name: string; target: { kind: "url"; port: number } | { kind: "command"; command: string } }): Promise<boolean>, ownPorts(): Promise<number[]>, definition(name: string): Promise<{ command: string; args: string[]; env: Record<string,string> } | null>, environment?, home?, connect?, spawn?, now?, platform?, declineMs?, connectMs? }): { open(target: { name: string; port?: number; fingerprint?: string }): Promise<{ socket: Duplex } | { refused: "needs-approval" | "declined" } | { failed: "bad-port" | "no-server" | "changed" | "unreachable" | "timeout" | "spawn-failed" }>; close(): void }`.

- [ ] **Step 1: Write the failing tests** (B's `device-mcp.node-test.mjs` minus the config.json cases, plus)

```js
test("a URL target: bad port or own port is bad-port; unapproved shows the prompt once and refuses needs-approval; after Allow the next open connects", ...);
test("a command target fetches the definition, prompts with the shown command (secrets hidden, env never shown), and spawns with inheritedEnvironment and the saved env", ...);
test("a changed definition under an old approval asks again and runs nothing", async () => {
  // approvals[name] = { kind: "command", fingerprint: F1 }; definition() now fingerprints F2 and the frame says F2 → prompt shown, { refused: "needs-approval" }, spawn not called
  // frame says F1 but definition fingerprints F2 → { failed: "changed" }, no prompt, spawn not called
});
test("a no holds ten minutes per name and per target; one prompt at a time across servers", ...);
test("ending the stream kills the child's tree; close() kills one still starting; stderr is never read", ...);
test("windowsLaunch and taskkill /T are used on win32", ...);   // platform: "win32", spawn stub sees cmd.exe /d /s /c for a .cmd shim, and taskkill /pid <pid> /T /F when the stream ends
// electron/lent-mcp.node-test.mjs
test("killTree ends the process group, or taskkill /T /F on win32", ...);
```

- [ ] **Step 2: Run** — `node --test electron/device-mcp.node-test.mjs electron/lent-mcp.node-test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `device-mcp.mjs`: B's `createMcpDoor` with `wantedFor` rewritten: `port !== undefined` → port rule (`Number.isInteger`, 1024–65535, not in `await ownPorts()`) → `{ wanted: { kind: "url", port } }`; `fingerprint` → `entry = await definition(name)`; null → `no-server`; `commandFingerprint(entry) !== fingerprint` → `changed`; else `{ wanted: { kind: "command", fingerprint }, entry }`. `run()` uses `windowsLaunch` on win32 and `{ ...(await environment()), ...entry.env }` otherwise (A's `INHERITED` list + `commandPath()`), `stdio: ["pipe", "pipe", "ignore"]`, `detached` off Windows. Keep B's `childStream`, `ask`, `holds`, `reach`, `generation`, but childStream's own kill code goes: it calls `killTree(child, { platform, spawn })` with the door's injected `platform` and `spawn`.
- `lent-mcp.mjs`: `killTree` gains the injectable `{ platform, spawn }` and is exported; its existing caller passes nothing.
- Nothing in `computer-sharing.mjs`, `shared-computer-access.mjs` or the job client changes in this task (Task 7 removes the job client once the connector speaks the link).

- [ ] **Step 4: Run** — Step 2's command plus `node --test "electron/*.node-test.mjs"` and `pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): a door onto this computer's MCP servers that asks its person once per server"`

---

### Task 7: The lending switch, approvals and registration on the computer

**Files:**
- Modify: `electron/computer-sharing.mjs`, `electron/computer-sharing.d.mts` (from B's diff: `mcp` grant, `lendMcp`, `mcpApprovals`, `lends()`, connect body, `supportsMcpLink`, `keepLink` condition, activity row; and the job client removal below, around :8, :112, :115-120, :423 and :521-524)
- Modify: `electron/lent-mcp.mjs`, `electron/lent-mcp.d.mts` (drop the job client; keep `ownPorts`, `windowsLaunch`, `inheritedEnvironment`, `ownEnvironmentIds`, `killTree`, `commandFingerprint`)
- Modify: `electron/shared-computer-access.mjs` (`executeSharedOperation` drops `lentMcp`; MCP jobs refused with a sentence)
- Modify: `electron/lending-activity-window.mjs` and `src/components/LendingActivity.tsx` (map action `mcp`), `electron/lending-words.mjs` (`lending.action.mcp` in all 16 inline packs), `src/locales/*.json` (16 packs: `lending.action.mcp` and `native.lend.mcpSignIn`)
- Modify: `server/cloud-lent-mcp.e2e.test.ts` (its MCP cases move onto the stream path so they stay green)
- Test: `electron/lend-automatically.node-test.mjs`, `electron/cloud-lending.node-test.mjs`, `electron/lent-mcp.node-test.mjs`, `server/cloud-lent-mcp.e2e.test.ts`

**Interfaces:**
- Consumes: `createMcpDoor` (Task 6), `runDeviceLink`'s `mcp` option and `lends().mcp` (Task 1), the `mcp-server` route answering `{ server: Definition | null }` (Task 4).
- Produces: `createComputerSharing({ …, mcp?: (env, definition: (name: string) => Promise<Definition | null>) => { open(target); close() } })`; `lendMcp(on: boolean): Promise<void> | undefined`; `mcpApprovals: { read(); write(next) }`; `cloudState(env).mcp: boolean`; `summary().mcp: boolean`; connect body `mcp: grant.mcp === true` only when `supportsMcpLink.has(env.id)` (describe: `capabilities.lentMcpLink === true`); `MCP_JOBS_MOVED` exported from `electron/lent-mcp.mjs`.

- [ ] **Step 1: Write the failing tests**

```js
test("the connect body carries mcp only to a Cloud that advertises lentMcpLink, and the link stays open while MCP is lent", ...);
test("lendMcp(true) needs a signed-in account, persists mcpAccount, and the automatic pass re-lends with mcp", ...);
test("one door per env: two opens share the decline hold, and stop(id) closes that door", ...);
test("turning the switch off ends the link, forgets approvals and ends every child", async () => {
  // approvals written while on; lendMcp(false) → mcpApprovals.read() is {}; the door's close() was called; the link's lends().mcp is false
});
test("an approval written after the switch went off is dropped", ...);
test("a stream's outcome is one activity row: action mcp, detail the server's name, never a port or command", ...);
// electron/lent-mcp.node-test.mjs: remove the job client's tests; keep ownPorts, windowsLaunch, inheritedEnvironment, ownEnvironmentIds, killTree, commandFingerprint tests
test("an mcp_tools job is answered with one sentence and starts nothing", ...);
```

- [ ] **Step 2: Run** — `node --test electron/lend-automatically.node-test.mjs electron/cloud-lending.node-test.mjs electron/lent-mcp.node-test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

- From B's `computer-sharing.mjs` diff, with these differences: capability name `lentMcpLink`; no `localEnvironmentId` (A's `environments` stays). One door per env (Ruling 10): built once when that env's link starts in `keepLink`, as `mcp(env, name => request(env, \`/api/shared-computers/${grant.id}/mcp-server\`, { name }, signal, grant.secret).then(r => r.server))`, handed to `runDeviceLink` as its `mcp` option, and closed in `stop(id)` and when the switch goes off. `lendMcp(true)` without a signed-in account refuses with `native.lend.mcpSignIn`.
- The job client goes: `lent-mcp.mjs` deletes `createLentMcp`, `stdioClient`, `httpClient`, `answerOf`, `validLentMcpServer`, `lentMcpRefusal`, `LENT_MCP_ACTIONS` and exports `MCP_JOBS_MOVED = "This computer runs MCP servers for My Cloud only through its link now; this My Cloud is too old to use it."`; `shared-computer-access.mjs`: `executeSharedOperation(grant, operation, signal, cua)` with `if (operation.action === "mcp_tools" || operation.action === "mcp_call") throw new Error(MCP_JOBS_MOVED)`; `computer-sharing.mjs`: `JOB_ACTIONS` keeps the two names (so the job is answered, not "Invalid"), `validSharedOperation` no longer validates `server`, `live.mcp` and the `createLentMcp` argument go.
- Words: `lending.action.mcp` ("Used an MCP server") in every pack of `lending-words.mjs` and of `src/locales`; `native.lend.mcpSignIn` (`Sign in to My Cloud before lending it your MCP servers.`) in every `src/locales` pack; then `node scripts/generate-locale.mjs --record-hashes` and `--check`.
- `server/cloud-lent-mcp.e2e.test.ts`: the connector now sends `mcp`, so its MCP cases call `lendMcp(true)` and give the connector `mcp: (env, definition) => createMcpDoor({ approvals, prompt: async () => true, ownPorts: …, definition, … })`; keep every assertion that still holds on the stream path (tools listed, call answered, the Mac's server saw the saved header). The case "notes starts a program … doesn't let My Cloud run programs" becomes: a first call answers needs-approval (the prompt was shown once), and after Allow the command server answers.

- [ ] **Step 4: Run** — Step 2's command plus `node --test "electron/*.node-test.mjs"`, `pnpm vitest run server/cloud-lent-mcp.e2e.test.ts server/lent-mcp-link.e2e.test.ts src/locales` and `pnpm typecheck && pnpm lint`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): lend this computer's MCP servers to My Cloud with a switch, remembered Allows and a link kept open"`

---

### Task 8: The prompt, the menu item, main wiring and the words

**Files:**
- Modify: `electron/lending-dialogs.mjs` (`allowMcpServer`), `electron/lending-indicator.mjs` (checkbox + `onMcp`), `electron/main.mjs` existing lines only: an existing import line (B used :39) for `lentMcpOptions`, `:1444-1448` and `:1495-1498`
- Create: `electron/lent-mcp-wiring.mjs` (from B, adapted: no `configFile`, no `ports`, no `chromeOptions`)
- Modify: `src/locales/*.json` (16 packs), `src/locales/source-hashes.json` (only through `--record-hashes`)
- Test: `electron/lending-dialogs.node-test.mjs`, and the node tests where the terminal checkbox is tested today (find them with `grep -ln "lendTray" electron/*.node-test.mjs`; B touched lend-automatically, native-language and screen-status)

**Interfaces:**
- Consumes: `createMcpDoor` (Task 6), `createComputerSharing`'s `mcp` option, `lendMcp` (Task 7), #4744's `ownPorts({ serverPorts, dirs })` and the `serverPorts` option already passed on `main.mjs:1447`.
- Produces: `lendingDialogs.allowMcpServer({ name, target }): Promise<boolean>`; `createLendingIndicator({ …, onMcp(on: boolean) })` and `update({ …, mcp })`; `lentMcpOptions({ sharing, prompt, ...door }) → { mcp: (env, definition) => door }` where `door` (e.g. `declineMs`, `now`, `spawn`) is passed through to `createMcpDoor`, and the door's `ownPorts` is #4744's `ownPorts` over the same `serverPorts` the computer-sharing options carry.
- Locale keys (English values; every other pack gets a translation):
  - `native.lendTray.mcp`: `Let My Cloud use your MCP servers on this {device}`
  - `native.lend.mcp.title`: `Let My Cloud use {name} on this {device}?`
  - `native.lend.mcp.port`: `A server at port {port} on this {device}. My Cloud's bots would send it requests through OpenMausBot.`
  - `native.lend.mcp.command`: `It runs this command here as you, with its saved settings (secrets hidden):\n{command}`
  - `native.lend.mcp.allow`: `Allow`
  - `native.lend.mcp.deny`: `Don't allow`
  - `native.lend.chooseCapability` stays unchanged (Ruling 18); `native.lend.mcpSignIn` was added in Task 7.

- [ ] **Step 1: Write the failing tests**

```js
test("allowMcpServer defaults to Don't allow, names the port or the shown command, and returns true only for Allow", ...);
test("the lending menu shows the MCP servers checkbox with the device word and calls onMcp with the new state", ...);
test("lentMcpOptions builds the door with the computer's own ports and passes door options through", ...);
```

- [ ] **Step 2: Run** — `node --test electron/lending-dialogs.node-test.mjs <the lendTray test files>` and `pnpm vitest run src/locales`. Expected: FAIL.
- [ ] **Step 3: Implement** B's dialog and indicator changes, `lent-mcp-wiring.mjs`, and on `main.mjs:1447` add `...lentMcpOptions({ sharing: sharingController, prompt: ask => lendingDialogs.allowMcpServer(ask) })` to the existing `createComputerSharing` spread line, and `onMcp: on => void sharingController().lendMcp(on)?.catch(error => slog(\`lending mcp: ${error?.message ?? error}\`))` on the existing `createLendingIndicator` line. Add the keys to all 16 packs; run `node scripts/generate-locale.mjs --record-hashes`, then `--check`. No new native-keys test: `checkCatalogs` already checks every key in every pack.
- [ ] **Step 4: Run** — Step 2's command plus `pnpm typecheck && pnpm lint && pnpm vitest run scripts/testing/file-size-ratchet.test.ts`. Expected: PASS; `electron/main.mjs` line count unchanged.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): ask once per MCP server before My Cloud uses it on this computer"`

---

### Task 9: End to end with the real connector, real door and real server

**Files:**
- Modify: `server/cloud-lent-mcp.e2e.test.ts`
- Test: itself

**Interfaces:**
- Consumes: everything above; Task 7 already moved this file's MCP cases onto the stream path with a door from `createMcpDoor`. Here the connector gets `mcp: lentMcpOptions({ sharing, prompt: stub, declineMs, now }).mcp` (the real wiring) and `lendMcp(true)` is called in the test.

- [ ] **Step 1: Extend A's e2e test** (keep every existing assertion that still holds; A's `client === "openmausbot-lent"` assertion does not apply on the stream path, where the engine's own client name passes through)

```ts
it("a bot on My Cloud uses MCP servers on the person's lent Mac through its link, only as the person allows there", async () => {
  // switch off: test → 409 "…isn't lending its MCP servers to My Cloud…"; the bot's prompt names it; no job is queued and no stream opens
  // lendMcp(true), prompt stub answers false: the first call answers needs-approval (the prompt was shown once); the next call inside the hold answers "…the person didn't allow local…" with no second prompt
  // after the hold (advance `now` past declineMs) the prompt stub answers true: tools/list and tools/call answer; macRequests carry "Bearer mac-header-key" and never the turn bearer; the fake server saw Connection: close and Host 127.0.0.1:<port>
  // the command server: Allow → the child is a child of the connector process (parent === process.pid), answers, and a DELETE from the engine ends it; who.key === "mac-env-key" (the env reached the child) and "mac-env-key" never appears in captured link control frames, the server log, the bot's turn dump or lending activity
  // two calls side by side: a slow fake tool (3 s) and a fast one finish out of order
  // the old SSE transport: a fake sse-type server mounted with type "sse" lists its tools
  // connector.pause(): the stream path says "no longer lends itself to My Cloud"
});
```

- [ ] **Step 2: Run** — `pnpm vitest run server/cloud-lent-mcp.e2e.test.ts server/lent-mcp-link.e2e.test.ts`. Expected: PASS.
- [ ] **Step 3: Full gate** — `pnpm typecheck && pnpm lint && pnpm vitest run && node --test "electron/*.node-test.mjs"`. Expected: clean.
- [ ] **Step 4: Commit** — `git commit -m "test(cloud): lent MCP end to end through the real connector, door and link"`

---

## Self-review notes

- Spec coverage: streams (Tasks 1–5), consent (Tasks 6–8), rollout gate and older computers (Tasks 1, 4, 5), plain words (Tasks 3, 4), anti-goals (Tasks 5, 6, 7 tests on frames, stderr, activity rows), Windows (Task 6), words in 16 packs (Task 8), e2e through a real link pair (Tasks 5, 9), migration (Task 5).
- Names used across tasks: `mcpLink`, `mcpRoute`, `McpOpen`, `commandFingerprint`, `lentLine`, `LentProblem`, `linkProblem`, `replayHttp`, `replayPath`, `killTree`, `StdioSessions`, `LinkEnd`, `createMcpDoor`, `lendMcp`, `mcpApprovals`, `lentMcpLink`, `MCP_JOBS_MOVED`, `lentMcpOptions`.
