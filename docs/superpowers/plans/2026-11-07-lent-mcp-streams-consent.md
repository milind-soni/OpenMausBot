# Lent MCP: streams and consent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move My Cloud's calls to MCP servers on a lent computer off the one-job queue onto device-link streams, and make the computer ask its person once per server before it reaches or runs one.

**Architecture:** A (main) keeps its surface in `server/lent-mcp.ts` and `electron/computer-sharing.mjs`; a second path is chosen per computer from its registration's `mcp` field. On My Cloud the existing internal route replays HTTP onto a link stream (URL server) or speaks Streamable HTTP to a per-thread stdio session over a stream (command server). On the computer a door (`electron/device-mcp.mjs`, from B) answers each open from its own approvals and a native prompt. Older computers keep the job path.

**Tech Stack:** Node 24, TypeScript (`server/`), ESM JavaScript (`electron/`), vitest, `node --test`, zod, `ws`.

**Spec:** `docs/superpowers/specs/2026-11-07-lent-mcp-streams-consent-design.md`

**Base:** `origin/main` at 1bc4749aa, branch `feat/lent-mcp-streams-consent`. PR #4744 (`fix/lent-mcp-own-ports`) and #4745 (`fix/lent-mcp-no-computer`) are expected to merge first: rebase onto them before Task 6 (which reuses #4744's `ownPorts`) and keep their tests green; nothing here undoes them.

## Global Constraints

- Node 24 on PATH for every command: `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"` (the default shell has Node 22).
- Before each commit: `pnpm typecheck` and `pnpm lint` pass; `pnpm vitest run scripts/testing/file-size-ratchet.test.ts` passes with no number in `LINES` raised. `server/index.ts` (15636) and `electron/main.mjs` (3232) are pinned: change them only on existing lines, never add a line.
- New wiring goes in `server/host/` factories or the module it belongs to, never in `server/index.ts`.
- Every new UI string key goes in all 16 packs under `src/locales/` (de, en, es, fr, hi, it, ja, ko, pl, pt-br, ru, tr, uk, vi, zh-tw, zh), then `node scripts/generate-locale.mjs --check` passes (it refreshes `source-hashes.json`). `electron/lending-words.mjs` keeps its own 16 inline packs: a key added there goes in each.
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
- Modify: `server/device-links.ts` (`LinkedComputer`, `mcpRoute`)
- Modify: `electron/device-link-protocol.mjs`, `electron/device-link-protocol.d.mts` (open frame)
- Modify: `server/environment.ts` (capability `lentMcpLink`)
- Test: `server/shared-computers.test.ts`, `server/device-links.test.ts`, `electron/device-link.node-test.mjs`, `server/environment.test.ts`

**Interfaces:**
- Produces: registration field `mcp?: boolean`; `runsOn().online.mcpLink: boolean | null`; `LinkedComputer.id: string; mcp: boolean`; `DeviceLinks.mcpRoute(person: string, computerId: string): McpRoute | null` with `McpRoute = { open(target: McpOpen): Promise<LinkOpened> }`; `McpOpen = { name: string; port: number } | { name: string; fingerprint: string }`; `LinkMux.open({ mcp: McpOpen })`; the computer's `accept` receives `{ mcp: McpOpen }`; `capabilities.lentMcpLink?: true`.

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
test("an open with mcp reaches accept as { mcp: { name, port } } and { mcp: { name, fingerprint } }", ...);
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
- `DeviceLinks.mcpRoute(person, computerId)`: copy `chromeRoute`, filter `link.computer.id === computerId && link.computer.mcp`, open `{ mcp: target }`.
- `device-link-protocol.mjs`: B's `openTarget` and `open()` control branch for `target.mcp`; `.d.mts` `open(target: { host; port } | { chrome: true } | { mcp: McpOpen })`.
- `environment.ts`: `lentMcpLink: true as const` under the `myChromeLink` condition; add to the capabilities type.

- [ ] **Step 4: Run the tests to verify they pass**

Run: same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/shared-computers.ts server/shared-computers.test.ts server/device-links.ts server/device-links.test.ts electron/device-link-protocol.mjs electron/device-link-protocol.d.mts electron/device-link.node-test.mjs server/environment.ts server/environment.test.ts
git commit -m "feat(cloud): a lent computer's registration says whether it lends MCP over its link, and the link opens MCP streams"
```

---

### Task 2: Stdio sessions over a link stream

**Files:**
- Create: `server/lent-mcp-stdio.ts` (copy B's `server/lent-mcp-stdio.ts`)
- Test: `server/lent-mcp-stdio.test.ts` (copy B's)

**Interfaces:**
- Produces: `class LinkEnd extends Duplex { static pair(): [LinkEnd, LinkEnd] }`; `class StdioSessions { constructor(deps: { open(): Promise<LinkOpened>; idleMs: number; now?(): number; sweepMs?: number }); get size(): number; handle(req: IncomingMessage, res: ServerResponse): Promise<"opened" | Exclude<LinkOpened, LinkStream> | void>; drop(): void; close(): void }`.

- [ ] **Step 1: Copy B's test file and run it to verify it fails**

Run: `pnpm vitest run server/lent-mcp-stdio.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Copy B's module unchanged**

`createLineSplitter` comes from `server/mcp-bridge.ts` (exists on main). Keep B's comment on why `LinkEnd` exists (a Node 24.14.1 `duplexPair` fact) and the `Security:` line on session ending.

- [ ] **Step 3: Run the tests to verify they pass**

Run: `pnpm vitest run server/lent-mcp-stdio.test.ts`. Expected: PASS, 8 tests.

- [ ] **Step 4: Commit**

```bash
git add server/lent-mcp-stdio.ts server/lent-mcp-stdio.test.ts
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
  - `export type LentMcpProblem = "offline" | "not-lent" | "needs-approval" | "declined" | "no-server" | "unreachable" | "changed"`
  - `export function linkProblem(opened: Exclude<LinkOpened, LinkStream>): LentMcpProblem` (B's, plus `failed: "changed"` → `"changed"`, `failed: "bad-port"` → `"unreachable"`).
  - `export function problemLine(problem: LentMcpProblem, name: string, computer: { name: string; device: "PC" | "Mac" | "computer" }, place: string): string` with these exact texts:
    - offline: `${name} runs on ${computer.name}, which isn't online.`
    - not-lent: `${name} runs on ${computer.name}, which isn't lending its MCP servers to ${place}: turn on "Let My Cloud use your MCP servers on this ${device}" from the OpenMausBot icon on that ${device}.`
    - needs-approval: `Allow ${name} on ${computer.name}: a prompt is waiting there. Then try again.`
    - declined: `On ${computer.name}, the person didn't allow ${name}. Ask them before trying again.`
    - no-server: `${computer.name} has no definition of ${name} to run.`
    - changed: `${name} changed since the person allowed it on ${computer.name}: a new prompt is waiting there.`
    - unreachable: `${name} on ${computer.name} didn't answer. Check that it is running there.`
  - `export function replayHttp(req: IncomingMessage, res: ServerResponse, opened: LinkStream, target: { port: number; path: string; prefix: string }): void` — B's `#serve` URL branch: `http.request({ createConnection: () => ours, method, path: target.path + rest, headers: { ...req.headers, host: \`127.0.0.1:${port}\`, connection: "close" } })`, response headers minus `connection`, `flushHeaders()`, `pipeline(answer, res)`; when the answer is `text/event-stream`, pass it through a Transform that rewrites `event: endpoint` data from `<path>` to `${target.prefix}<path>` (one line, split on `\n`).

- [ ] **Step 1: Write the failing tests** (fake server on a loopback port joined by `LinkEnd.pair()`; B's `server/lent-mcp-doors.test.ts` has the harness to copy)

```ts
it("a request is replayed with the prefix stripped, Host rewritten and Connection close", ...);
it("SSE streams through and Connection: close is not passed on", ...);
it("an SSE endpoint event is re-prefixed", async () => {
  // fake server answers `event: endpoint\ndata: /messages?sessionId=1\n\n`; client under prefix "/api/internal/lent/mcp/local"
  // sees data "/api/internal/lent/mcp/local/messages?sessionId=1"
});
it("problemLine says each case in plain words", ...);  // the seven exact texts
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run server/lent-mcp-link.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `server/lent-mcp-link.ts`** as above.
- [ ] **Step 4: Run to verify they pass.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(cloud): replay a URL MCP server's requests onto a lent computer's link stream"`

---

### Task 4: `server/lent-mcp.ts` takes the stream path

**Files:**
- Modify: `server/lent-mcp.ts` (`LentMcpDeps`, `lentState`, `lentLine`, `mounts`, `route`, `test`)
- Modify: `server/routes/shared-computers.ts` (the `mcp-server` definition route)
- Modify: `server/index.ts:2842` (add `links: deviceLinks` to `createLentMcp({...})` on that line) and `server/index.ts:12120` (pass `lentMcp` to `createSharedComputerRoutes` on that line)
- Test: `server/lent-mcp.test.ts`, `server/routes/shared-computers.test.ts`

**Interfaces:**
- Consumes: `mcpRoute` (Task 1), `StdioSessions`/`LinkEnd` (Task 2), `replayHttp`/`problemLine`/`linkProblem` (Task 3).
- Produces:
  - `LentMcpDeps.links: Pick<DeviceLinks, "mcpRoute">`.
  - `LentState` ready: `{ kind: "ready"; computerId: string; link: boolean; computer: string; device }`; new `{ kind: "not-lending"; computer; device }` with `lentLine` text `${name} runs on ${theirs}, which isn't lending its MCP servers to ${place}: turn on "Let My Cloud use your MCP servers on this ${device}" from the OpenMausBot icon on that ${device}.`
  - `lentState`: `online.mcpLink === false` → `not-lending`; `=== true` → ready with `link: true` (no terminal check); `null` → A's rules (`no-terminal`, `port`), `link: false`.
  - `export function commandFingerprint(server: { command: string; args: string[]; env: Record<string, string> }): string` — sha256 of `JSON.stringify([command, args, Object.keys(env).sort()])` (B's; must equal the computer's).
  - `createLentMcp(deps)` additionally returns `definition(principal: string, computerId: string, name: string): LentMcpServer | null` (a command server of that principal whose `runsOn` names that computer, as `lentDefinition`; null for a URL server or none).
  - `route()` on the stream path accepts GET, POST, DELETE.
  - `test()` unchanged signature.

- [ ] **Step 1: Write the failing tests** (extend `server/lent-mcp.test.ts` with a fixture whose `computers.runsOn` returns `mcpLink: true` and whose `links.mcpRoute` returns a fake route backed by `LinkEnd.pair()` and a fake HTTP MCP server / a fake stdio child from `server/testing/fake-stdio-mcp.mjs`, copied from B)

```ts
it("a computer that lends mcp is reached over its link: tools/list and tools/call for a URL server go through, no job is queued", ...);
it("a command server gets one stdio session per thread, kept across turns, ended by DELETE", ...);
it("route answers a refused open as the bot reads it", async () => {
  // route.open → { refused: "needs-approval" }; POST tools/call → 200 with result.isError and text "Allow local on Ada's Mac: a prompt is waiting there. Then try again."
  // route.open → { refused: "declined" }; POST tools/list → jsonrpc error with "On Ada's Mac, the person didn't allow local. Ask them before trying again."
});
it("a computer with the switch off is not-lending: mounts leaves it out, lines says so, nothing is opened", ...);
it("a URL server on the old SSE transport mounts with type sse", ...);
it("test on the stream path probes the server through an ephemeral loopback door and reports the open's problem", ...);
it("definition serves a command server's definition for its own computer and nothing for a URL server or another computer", ...);
it("an older computer (mcpLink null) still takes the job path", ...);   // A's existing tests keep passing
// server/routes/shared-computers.test.ts
it("POST /api/shared-computers/:id/mcp-server answers the definition only with that computer's secret", ...);
```

- [ ] **Step 2: Run to verify they fail** — `pnpm vitest run server/lent-mcp.test.ts server/routes/shared-computers.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `route()`: `if (state.link)` → `serve(ctx.req, ctx.res, { name, server, state, thread: ctx.turn.threadId })`; else A's `rpc()` as today (now POST-only check moves inside the job branch).
- `serve()`: URL server → `route.open({ name, port })`; command → `sessions.get(thread+name) ??= new StdioSessions({ open: () => route.open({ name, fingerprint: commandFingerprint(server) }), idleMs: 600_000 })` then `handle(req, res)`. On a refusal/failure (`!("join" in opened)` or `handle()` returning one): read the body with `ctx.readBody()`, answer `callError`/`rpcError` with `problemLine(linkProblem(opened), name, state, deps.place)`; a notification gets 202.
- Sessions keyed `${threadId}\n${name}`; dropped when `deps.computers` reports the computer gone (poll `runsOn` on each request: a different `computerId` closes the old sessions) and in `close()`; `StdioSessions` idle sweep ends the rest.
- `test()`: `http.createServer((req, res) => serve(req, res, { ..., thread: \`test-${randomUUID()}\` }))` on `127.0.0.1:0`, probe `{ type: server.type ?? "http", url: \`http://127.0.0.1:${port}/${token}\`, headers: isRemote ? server.headers : {} }` with `probeMcpServer`, record the last problem of that thread, close the server and its sessions in `finally`; a problem wins over the probe's generic error text.
- `mounts()`: `type: isRemoteMcpServer(server) ? server.type : "http"`.
- `definition()` and the route in `server/routes/shared-computers.ts` beside `poll|lease|result|disconnect`: `mcp-server` → `json(res, 200, { server })` or 404; authorization identical to `lease`.
- `createLentMcp` return gains `close(): void` (ends every session); call it from the existing `sharedComputers.close()` line in `server/index.ts:15586` only if it can be done on that line without adding one — otherwise end sessions when `runsOn` reports the computer gone and at the `StdioSessions` sweep, and leave shutdown to process exit.

- [ ] **Step 4: Run to verify they pass** — same command plus `pnpm vitest run server/cloud-lent-mcp.e2e.test.ts` (A's e2e: the real connector does not send `mcp` yet, so the job path must still pass end to end). Expected: PASS.
- [ ] **Step 5: `pnpm typecheck && pnpm lint && pnpm vitest run scripts/testing/file-size-ratchet.test.ts`** — Expected: clean; `server/index.ts` line count unchanged.
- [ ] **Step 6: Commit** — `git commit -m "feat(cloud): reach a lent computer's MCP servers over its link, side by side and with the whole protocol"`

---

### Task 5: My Cloud end to end through a real link pair, and the migration test

**Files:**
- Create: `server/lent-mcp-link.e2e.test.ts` (from B's `server/lent-mcp.e2e.test.ts`, adapted)
- Create: `server/testing/fake-stdio-mcp.mjs`, `server/testing/stdio-mcp-child.ts` (copy B's)
- Modify: `server/cloud-lent-mcp.e2e.test.ts` (migration case)

**Interfaces:**
- Consumes: `DeviceLinks` + `runDeviceLink` (real link pair over a `ws` server), `createLentMcp` (Task 4) with a stub door on the computer side (`mcp: { open }` as `runDeviceLink`'s option, which Task 6 implements for real).

- [ ] **Step 1: Write the tests**

```ts
// server/lent-mcp-link.e2e.test.ts — real DeviceLinks on a ws server, real runDeviceLink client, stub door
it("two tools/call to one server run side by side over one link", ...);   // first call blocks 2 s in the fake server; second answers first
it("a command server's child lives between calls and ends on DELETE; its stderr never reaches My Cloud", ...);
it("server-sent notifications reach the engine's GET stream", ...);
it("not-lent, needs-approval and declined from the door become the bot's plain words", ...);
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
- Modify: `electron/lent-mcp.mjs`, `electron/lent-mcp.d.mts` (drop the job client; keep helpers)
- Modify: `electron/shared-computer-access.mjs` (`executeSharedOperation` drops `lentMcp`; MCP jobs refused with a sentence)
- Modify: `electron/computer-sharing.mjs:521-524` (no `createLentMcp`; `live.mcp` removed)
- Test: `electron/device-mcp.node-test.mjs` (from B, adapted), `electron/lent-mcp.node-test.mjs`

**Interfaces:**
- Consumes: `ownPorts` (#4744, `electron/lent-mcp.mjs`), `windowsLaunch`, `inheritedEnvironment`, `commandPath()` (`electron/shell-path.mjs`).
- Produces:
  - `export function commandFingerprint({ command, args, env }): string` (same bytes as Task 4's).
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
test("windowsLaunch is used on win32", ...);   // platform: "win32", spawn stub sees cmd.exe /d /s /c for a .cmd shim
// electron/lent-mcp.node-test.mjs: remove the client tests; keep ownPorts, windowsLaunch, inheritedEnvironment, ownEnvironmentIds tests
test("an mcp_tools job is answered with one sentence and starts nothing", ...);
```

- [ ] **Step 2: Run** — `node --test electron/device-mcp.node-test.mjs electron/lent-mcp.node-test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement**

- `device-mcp.mjs`: B's `createMcpDoor` with `wantedFor` rewritten: `port !== undefined` → port rule (`Number.isInteger`, 1024–65535, not in `await ownPorts()`) → `{ wanted: { kind: "url", port } }`; `fingerprint` → `entry = await definition(name)`; null → `no-server`; `commandFingerprint(entry) !== fingerprint` → `changed`; else `{ wanted: { kind: "command", fingerprint }, entry }`. `run()` uses `windowsLaunch` on win32 and `{ ...(await environment()), ...entry.env }` otherwise (A's `INHERITED` list + `commandPath()`), `stdio: ["pipe", "pipe", "ignore"]`, `detached` off Windows, A's `killTree`. Keep B's `childStream`, `ask`, `holds`, `reach`, `generation`.
- `lent-mcp.mjs`: delete `createLentMcp`, `stdioClient`, `httpClient`, `answerOf`, `validLentMcpServer`, `lentMcpRefusal`, `LENT_MCP_ACTIONS`; export `MCP_JOBS_MOVED = "This computer runs MCP servers for My Cloud only through its link now; this My Cloud is too old to use it."`.
- `shared-computer-access.mjs`: `executeSharedOperation(grant, operation, signal, cua)`; `if (operation.action === "mcp_tools" || operation.action === "mcp_call") throw new Error(MCP_JOBS_MOVED)`.
- `computer-sharing.mjs`: `JOB_ACTIONS` keeps the two names (so the job is answered, not "Invalid"); `validSharedOperation` no longer validates `server`; remove `live.mcp` and the `createLentMcp` argument.

- [ ] **Step 4: Run** — Step 2's command plus `node --test "electron/*.node-test.mjs"`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): a door onto this computer's MCP servers that asks its person once per server"`

---

### Task 7: The lending switch, approvals and registration on the computer

**Files:**
- Modify: `electron/computer-sharing.mjs`, `electron/computer-sharing.d.mts` (from B's diff: `mcp` grant, `lendMcp`, `mcpApprovals`, `lends()`, connect body, `supportsMcpLink`, `keepLink` condition, activity row)
- Modify: `electron/lending-activity.mjs`, `electron/lending-words.mjs` (`lending.action.mcp` in all 16 inline packs)
- Test: `electron/lend-automatically.node-test.mjs`, `electron/cloud-lending.node-test.mjs`, `electron/device-link.node-test.mjs`

**Interfaces:**
- Consumes: `createMcpDoor` (Task 6), `runDeviceLink`'s `mcp` option (B's: `mcp: { open(target) }`, `lends()` returns `{ internet, chrome, mcp }`, refusal `not-lent` when `mcp` is off) — add that to `electron/device-link.mjs` here.
- Produces: `createComputerSharing({ …, mcp?: (env, call) => { open(target) } })` where `call(name)` fetches that env's definition; `lendMcp(on: boolean): Promise<void> | undefined`; `mcpApprovals: { read(); write(next) }`; `cloudState(env).mcp: boolean`; `summary().mcp: boolean`; connect body `mcp: grant.mcp === true` only when `supportsMcpLink.has(env.id)` (describe: `capabilities.lentMcpLink === true`).

- [ ] **Step 1: Write the failing tests**

```js
test("the connect body carries mcp only to a Cloud that advertises lentMcpLink, and the link stays open while MCP is lent", ...);
test("lendMcp(true) needs a signed-in account, persists mcpAccount, and the automatic pass re-lends with mcp", ...);
test("turning the switch off ends the link, forgets approvals and ends every child", async () => {
  // approvals written while on; lendMcp(false) → mcpApprovals.read() is {}; the door's close() was called; the link's lends().mcp is false
});
test("an approval written after the switch went off is dropped", ...);
test("a stream's outcome is one activity row: action mcp, detail the server's name, never a port or command", ...);
// device-link.node-test.mjs
test("an mcp open is refused not-lent unless lends().mcp, and otherwise goes to the mcp door", ...);
```

- [ ] **Step 2: Run** — `node --test electron/lend-automatically.node-test.mjs electron/cloud-lending.node-test.mjs electron/device-link.node-test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** from B's `computer-sharing.mjs` diff, with these differences: capability name `lentMcpLink`; no `localEnvironmentId` (A's `environments` stays); the door is built per env inside `keepLink` as `mcp: { open: target => mcpDoor(env, name => request(env, \`/api/shared-computers/${grant.id}/mcp-server\`, { name }, signal, grant.secret).then(r => r.server ?? null)).open(target) }` so a definition is fetched with that grant's secret; `stop(id)` calls the door's `close()` for that env. Add `lending.action.mcp` ("Used an MCP server") to every pack in `lending-words.mjs` and map action `mcp` in `lending-activity.mjs`.

- [ ] **Step 4: Run** — Step 2's command plus `node --test "electron/*.node-test.mjs"`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): lend this computer's MCP servers to My Cloud with a switch, remembered Allows and a link kept open"`

---

### Task 8: The prompt, the menu item, main wiring and the words

**Files:**
- Modify: `electron/lending-dialogs.mjs` (`allowMcpServer`), `electron/lending-indicator.mjs` (checkbox + `onMcp`), `electron/main.mjs:1444-1448` and `:1495-1498` (existing lines only)
- Create: `electron/lent-mcp-wiring.mjs` (from B, adapted: no `configFile`; `prompt`, `ports`)
- Modify: `src/locales/*.json` (16 packs), `src/locales/source-hashes.json` (regenerated)
- Test: `electron/lending-dialogs.node-test.mjs`, `electron/lending-indicator` tests (where the terminal checkbox is tested), `src/locales/native-keys.test.ts`

**Interfaces:**
- Consumes: `createMcpDoor` (Task 6), `createComputerSharing`'s `mcp` option, `lendMcp` (Task 7).
- Produces: `lendingDialogs.allowMcpServer({ name, target }): Promise<boolean>`; `createLendingIndicator({ …, onMcp(on: boolean) })` and `update({ …, mcp })`; `lentMcpOptions({ sharing, prompt, ports, chromeOptions }) → { mcp: (env, definition) => door }`.
- Locale keys (English values; every other pack gets a translation):
  - `native.lendTray.mcp`: `Let My Cloud use your MCP servers on this {device}`
  - `native.lend.mcpSignIn`: `Sign in to My Cloud before lending it your MCP servers.`
  - `native.lend.mcp.title`: `Let My Cloud use {name} on this {device}?`
  - `native.lend.mcp.port`: `A server at port {port} on this {device}. My Cloud's bots would send it requests through OpenMausBot.`
  - `native.lend.mcp.command`: `It runs this command here as you, with its saved settings (secrets hidden):\n{command}`
  - `native.lend.mcp.allow`: `Allow`
  - `native.lend.mcp.deny`: `Don't allow`
  - `native.lend.chooseCapability`: append `, or your MCP servers` before the final period (and in each pack).

- [ ] **Step 1: Write the failing tests**

```js
test("allowMcpServer defaults to Don't allow, names the port or the shown command, and returns true only for Allow", ...);
test("the lending menu shows the MCP servers checkbox with the device word and calls onMcp with the new state", ...);
// src/locales/native-keys.test.ts: every native.lend.mcp.* key exists in all 16 packs
```

- [ ] **Step 2: Run** — `node --test electron/lending-dialogs.node-test.mjs electron/lending-indicator*.node-test.mjs && pnpm vitest run src/locales`. Expected: FAIL.
- [ ] **Step 3: Implement** B's dialog and indicator changes, `lent-mcp-wiring.mjs`, and on `main.mjs:1447` add `...lentMcpOptions({ sharing: sharingController, prompt: ask => lendingDialogs.allowMcpServer(ask), ports: () => [SERVER_PORT] })` to the existing `createComputerSharing` spread line, and `onMcp: on => void sharingController().lendMcp(on)?.catch(error => slog(\`lending mcp: ${error?.message ?? error}\`))` on the existing `createLendingIndicator` line. Add the keys to all 16 packs; run `node scripts/generate-locale.mjs --check`.
- [ ] **Step 4: Run** — Step 2's command plus `pnpm typecheck && pnpm lint && pnpm vitest run scripts/testing/file-size-ratchet.test.ts`. Expected: PASS; `electron/main.mjs` line count unchanged.
- [ ] **Step 5: Commit** — `git commit -m "feat(desktop): ask once per MCP server before My Cloud uses it on this computer"`

---

### Task 9: End to end with the real connector, real door and real server

**Files:**
- Modify: `server/cloud-lent-mcp.e2e.test.ts`
- Test: itself

**Interfaces:**
- Consumes: everything above; the connector gets `mcp: lentMcpOptions({ … prompt: stub }).mcp` and `lendMcp(true)` is called in the test.

- [ ] **Step 1: Extend A's e2e test** (keep every existing assertion that still holds; the connector now sends `mcp`, so A's "notes starts a program … doesn't let My Cloud run programs" case becomes the not-lending / needs-approval / declined sequence)

```ts
it("a bot on My Cloud uses MCP servers on the person's lent Mac through its link, only as the person allows there", async () => {
  // switch off: test → 409 "…isn't lending its MCP servers to My Cloud…"; the bot's prompt names it; no job is queued and no stream opens
  // lendMcp(true), prompt stub answers false: tools/call → isError "On Ada's Mac, the person didn't allow local…"; a second call within the hold shows no second prompt
  // prompt stub answers true after the hold (advance declineMs via the door option): tools/list and tools/call answer; macRequests carry "Bearer mac-header-key"; the fake server saw Connection: close and Host 127.0.0.1:<port>
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
- Names used across tasks: `mcpLink`, `mcpRoute`, `McpOpen`, `commandFingerprint`, `problemLine`, `linkProblem`, `replayHttp`, `StdioSessions`, `LinkEnd`, `createMcpDoor`, `lendMcp`, `mcpApprovals`, `lentMcpLink`, `MCP_JOBS_MOVED`, `lentMcpOptions`.
