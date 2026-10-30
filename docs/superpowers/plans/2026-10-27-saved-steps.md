# Saved Steps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a bot's host-computer tool calls per request, save them as a recipe when the request succeeds and every step is safely replayable, and answer the same words later by replaying the steps with no model call, handing over to the AI with a note when a step fails.

**Architecture:** The host computer's gated MCP bridge (`server/mcp-bridge.ts`) posts each `tools/call` and its slimmed result to a new internal route before the engine sees the result; the server keeps that journal in memory per thread and counts the gate checks the bridge makes, so a lost entry is detectable. All logic lives in `server/saved-steps/`: a recipe builder (the saveability rules), a per-bot JSON store, a target resolver, a step runner and a dispatch wrapper modelled on `QuickModelFallback` that stands in for the engine for one turn. `server/index.ts` gains three lines; every other wiring edit changes an existing line.

**Tech Stack:** TypeScript on Node with `--experimental-strip-types`, vitest, zod, React + Tailwind renderer, cua-driver 0.28.2 over MCP stdio.

**Spec:** `docs/superpowers/specs/2026-10-27-saved-steps-design.md`

## Global Constraints

- Work only in `/Users/omkar/Desktop/openmaus/OpenGrokBot-learn-watch-talk` on `feat/learned-replay`. Never push. Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Comments follow `AGENTS.md`: only what code cannot say (vendor facts with version, wire doc comments in `shared/`, security invariants, known open risks). No narration.
- The server runs on type stripping: type-only imports are `import type` (or inline `type`).
- `server/index.ts` is at 16170 lines against a file-size ratchet of 16173 (`scripts/testing/file-size-ratchet.test.ts`). This plan adds exactly three lines there and removes one. `server/config.ts` (1365/1365), `src/components/ChatView.tsx` (1348/1348) and `src/state/store.tsx` (3456/3456) may not grow at all: their edits extend existing lines.
- `server/index.ts` may not gain a `path === "/` comparison (`scripts/testing/index-route-ratchet.test.ts`, at 92/92). New routes live in `server/routes/` modules; the journal path is compared through the constant `COMPUTER_JOURNAL_PATH`.
- Journalling runs only when `OMB_COMPUTER_JOURNAL=1`, which only `gatedLocalComputer` (`server/local-computer.ts:29-47`) sets. Local VM, VPS, Cloud Boat, team computers and the browser never journal or replay.
- Journal POST: `POST /api/internal/computer/journal`, body `{tool, arguments, result}`, awaited before the response is forwarded, 1 000 ms timeout, then forward anyway.
- cua-driver's MCP wire uses snake_case (`element_index`, `element_token`, `parent_index`, `window_id`, `window_title`, `app_name`, `bundle_id`); `node_modules/@trycua/cua-driver/dist/native/cua_driver_contract.d.ts` (`WindowElement` ~1379, `WindowStateOutput` ~1404, `AppInfo` ~90, `WindowInfo` ~935) gives the same fields in camelCase. The contract types no `launch_app` output: read its `pid`, `bundle_id`, `name` defensively.
- Element values (`value`, `valueDescription`), frames, screenshots and all `content` never leave the bridge.
- Recipe file: `DATA_DIR/bots/<botId>/saved-steps.json`, mode `0o600`, written with `writeFileAtomic` (`server/atomic.ts`); at most 200 recipes per bot; a recipe unused for 60 days is dropped.
- 1 to 40 action steps per recipe; a replayed step's call times out after 60 000 ms (past the control gate's 45 s hold).
- Replay runs only when the turn's `approvalMode === "full"`, the setting is on, the turn is a direct text-only person turn and `integrations.localComputer.scope === "local-computer"`.
- Approval per replayed action: `request.opened` with `tool: "mcp__computer__<name>"`, `approvalScope: "local-computer"`, `allowSession: false`.
- Key normalising: NFKC, lowercase, punctuation and symbols to spaces, filler phrases dropped as whole words (`please`, `can you`, `could you`, `hey`, `just`, `now`, `quickly`), spaces collapsed. Moment words: `this`, `that`, `it`, `here`, `there`, `these`, `those`, `them`.
- Never address a replayed step by `x`/`y`. A recipe never holds `element_token`, `element_index`, `pid`, `window_id` or `session`; targets are resolved fresh.
- Wire field: `WireMessage.savedSteps?: { recipeId: string; learned?: true; replayed?: true }`. Setting: `config.json` `features.savedSteps`, on unless `false`.
- Copy (English, `src/locales/en.json`): chips "Saved these steps · next time no AI" / "Repeated saved steps · no AI" with a "Forget" button; setting title "Repeat computer tasks without AI".
- Phones are untouched (no `mausbot-mobile` work); the forget route is not added to `CLIENT_ALLOW`.
- Test commands: `pnpm exec vitest run <file>`; `pnpm typecheck`; `pnpm lint`; `pnpm i18n:check`.
- Line numbers are those of commit `8a82b4a79`. A line an earlier task inserts shifts every later one, so find each edit by the code quoted beside it.

## Review Focus

- A journal entry that never arrives (POST timeout, server down, driver that never answers, `notifications/cancelled`) must leave the request unsaved, since a recipe missing one click would type into the wrong field. Pinned in Task 3 (`take` reports `complete: false` when gate checks and entries disagree) and Task 4 (`incomplete-journal`).
- A repeat whose words match by key but whose typed text differs ("type Hello, World" saved, "type hello world" sent) must go to the AI rather than type text the person did not write this time. Pinned in Task 4 (`recipeFitsRequest`) and Task 8 (no replay).
- Spoken (Live call), Slack-relayed, quoted-reply, app-pointed, Data-context and attachment lines must neither save nor replay; spoken words must never reach a file. Pinned in Task 4 (`personTextRequest`) and Task 9.
- Screen drift at replay (window renamed with one window open, two windows and none with the saved title, duplicate labels, app quit, `list_apps` listing a not-running app) must fail into the AI with the note, never guess. Pinned in Task 6.
- A corrupt, hand-edited or other-version `saved-steps.json` must never break a turn: read as empty, malformed recipes dropped, the next save rewrites it. Pinned in Task 5.

---

### Task 1: Request key and word rules

**Files:**
- Create: `server/saved-steps/key.ts`
- Test: `server/saved-steps/key.test.ts`

**Interfaces:**
- Produces: `requestKey(text: string): string`, `hasMomentWords(text: string): boolean`, `inRequest(fragment: string, request: string): boolean`, `firstSentence(text: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
describe("requestKey", () => {
  it("drops case, punctuation and filler words", () => {
    expect(requestKey("Hey, could you please open TextEdit and type hello world now!")).toBe("open textedit and type hello world");
    expect(requestKey("open textedit and type hello world")).toBe("open textedit and type hello world");
  });
  it("drops fillers only as whole words", () => expect(requestKey("Open Justin's notes")).toBe("open justin s notes"));
  it("normalises Unicode", () => expect(requestKey("Ｏｐｅｎ  Notes")).toBe("open notes"));
});
it("finds moment words as whole words", () => {
  expect(hasMomentWords("Send this to Ana")).toBe(true);
  expect(hasMomentWords("put it here")).toBe(true);
  expect(hasMomentWords("Open Thistle notes")).toBe(false);
});
it("matches typed text word for word, ignoring case", () => {
  expect(inRequest("Hello World", "type hello world please")).toBe(true);
  expect(inRequest("hello", "type helloworld")).toBe(false);
  expect(inRequest("a.b", "type a.b now")).toBe(true);
  expect(inRequest("hello world", "type hello, world")).toBe(false);
  expect(inRequest("  ", "anything")).toBe(false);
});
it("keeps the first sentence of a reply", () => {
  expect(firstSentence("Typed hello world into TextEdit. Nothing else changed.")).toBe("Typed hello world into TextEdit.");
  expect(firstSentence("   ")).toBeNull();
  expect(firstSentence("x ".repeat(400))!.length).toBeLessThanOrEqual(281);
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/key.test.ts`
Expected: FAIL, cannot find module `./key.ts`.

- [ ] **Step 3: Implement the four functions in `server/saved-steps/key.ts`**

`requestKey`: `normalize("NFKC")`, `toLowerCase()`, replace `/[\p{P}\p{S}]+/gu` with a space, collapse whitespace, remove the filler phrases (longest first) with `(?<![\p{L}\p{N}])phrase(?![\p{L}\p{N}])` (`u` flag), collapse and trim. `hasMomentWords`: any token of `requestKey(text).split(" ")` in the moment set. `inRequest`: trimmed fragment non-empty and found in `request` by the same Unicode word-boundary pattern with the fragment regex-escaped, flags `iu`. `firstSentence`: trimmed text up to and including the first `[.!?]` followed by whitespace or end; longer than 280 characters is cut at the last space before 280 and ends with `…`; `null` when it holds no letter or digit.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/saved-steps/key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/key.ts server/saved-steps/key.test.ts
git commit -m "feat(saved-steps): request key and word rules" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The bridge journals host-computer calls

**Files:**
- Create: `server/saved-steps/driver-wire.ts`, `server/saved-steps/journal-tap.ts`
- Modify: `server/mcp-bridge.ts:94-103` (`BridgeOptions`), `server/mcp-bridge.ts:198-290` (`runMcpBridge`), `server/local-computer-proxy.ts:6-37`, `server/local-computer.ts:29-47`
- Test: `server/saved-steps/driver-wire.test.ts`, `server/saved-steps/journal-tap.test.ts`, `server/local-computer-proxy.test.ts`, `server/local-computer.test.ts:99`

**Interfaces:**
- Produces (driver-wire.ts):
  - `interface WireElement { element_index: number; element_token?: string; role: string; label?: string; parent_index?: number; depth: number }`
  - `interface WireApp { pid: number; name: string; bundle_id?: string; running?: boolean }`
  - `interface WireWindow { window_id: number; pid?: number; title: string; app_name?: string }`
  - `interface SlimStructured { elements?: WireElement[]; apps?: WireApp[]; windows?: WireWindow[]; pid?: number; window_id?: number; bundle_id?: string; name?: string; app_name?: string; window_title?: string; refusal?: { code?: string; message?: string } }`
  - `interface SlimResult { isError: boolean; rpcError?: true; structured?: SlimStructured }`
  - `interface JournalEntry { tool: string; arguments: Record<string, unknown>; result: SlimResult }`
  - `const MAX_ELEMENTS = 1500`
  - `slimResponse(frame: unknown): SlimResult` (a JSON-RPC response frame)
  - `elementPath(elements: readonly WireElement[], element: WireElement): string[] | null` (ancestors' `role:label` from the root to the parent; `null` on a missing parent or a cycle)
- Produces (journal-tap.ts):
  - `const COMPUTER_JOURNAL_PATH = "/api/internal/computer/journal"`
  - `journalUrl(controlUrl: string): string`
  - `postJournal(url: string, token: string, fetchImpl?: typeof fetch): (entry: JournalEntry, signal: AbortSignal) => Promise<unknown>`
  - `createJournalTap(options: { post: (entry: JournalEntry, signal: AbortSignal) => Promise<unknown>; timeoutMs?: number }): { request(line: string): void; response(line: string): Promise<void> }` (`timeoutMs` default 1000; `response` never rejects)
  - `BridgeOptions.journal?: { url: string; token: string }`

- [ ] **Step 1: Write the failing tests**

`driver-wire.test.ts`:
```ts
it("keeps only what replay needs and drops every image and text", () => {
  const slim = slimResponse({ jsonrpc: "2.0", id: 3, result: {
    content: [{ type: "image", data: "AAAA" }, { type: "text", text: "secret text" }],
    structuredContent: { pid: 4242, window_id: 7, app_name: "TextEdit", window_title: "Untitled", snapshot_id: "x",
      elements: [{ element_index: 2, element_token: "s1-e2", role: "AXTextArea", label: "Document", value: "secret value",
        frame: { x: 1, y: 2, w: 3, h: 4 }, actions: ["AXPress"], parent_index: 1, depth: 2 }] } } });
  expect(slim).toEqual({ isError: false, structured: { pid: 4242, window_id: 7, app_name: "TextEdit", window_title: "Untitled",
    elements: [{ element_index: 2, element_token: "s1-e2", role: "AXTextArea", label: "Document", parent_index: 1, depth: 2 }] } });
  expect(JSON.stringify(slim)).not.toMatch(/AAAA|secret/);
});
it("flags RPC errors, isError and refusals", () => {
  expect(slimResponse({ id: 1, error: { code: -32601, message: "x" } })).toEqual({ isError: true, rpcError: true });
  expect(slimResponse({ id: 1, result: { content: [], isError: true } }).isError).toBe(true);
  expect(slimResponse({ id: 1, result: { content: [], structuredContent: { refusal: { code: "c", message: "m", extra: 1 } } } }).structured)
    .toEqual({ refusal: { code: "c", message: "m" } });
});
it("keeps apps and windows for identity", () => { /* apps[] -> {pid,name,bundle_id,running}; windows[] -> {window_id,pid,title,app_name} */ });
it("caps elements at MAX_ELEMENTS", () => { /* 1600 elements in, 1500 out */ });
it("walks an element's ancestors from the root", () => {
  // e0 AXWindow "Untitled" (no parent), e1 AXScrollArea (no label, parent 0), e2 AXTextArea "Document" (parent 1)
  expect(elementPath(elements, elements[2])).toEqual(["AXWindow:Untitled", "AXScrollArea:"]);
  expect(elementPath([{ ...elements[2], parent_index: 9 }], { ...elements[2], parent_index: 9 })).toBeNull();
});
```

`journal-tap.test.ts`:
```ts
it("posts a call with its slimmed result before the reply is released", async () => {
  let release!: () => void; const posted: JournalEntry[] = [];
  const tap = createJournalTap({ post: (entry) => { posted.push(entry); return new Promise<void>((r) => { release = r; }); } });
  tap.request(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "click", arguments: { element_token: "s1-e2" } } }));
  let done = false; const waiting = tap.response(JSON.stringify({ jsonrpc: "2.0", id: 5, result: { content: [] } })).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  expect(posted).toEqual([{ tool: "click", arguments: { element_token: "s1-e2" }, result: { isError: false } }]);
  release(); await waiting; expect(done).toBe(true);
});
it("releases after timeoutMs when the post hangs, and when it rejects", async () => { /* fake timers: hang -> resolved at 1000 ms; reject -> resolved at once */ });
it("ignores frames that are not answers to a tools/call", async () => { /* initialize reply, ping reply, unparsable line: post never called */ });
it("derives the journal URL from the control URL", () =>
  expect(journalUrl("http://127.0.0.1:4100/api/internal/computer-control?botId=b1")).toBe("http://127.0.0.1:4100/api/internal/computer/journal"));
```

`local-computer-proxy.test.ts`, new case beside the existing `describe`, reusing its `FAKE_DRIVER` child and `rpc` helper pattern with a loopback server that answers `GET /control` with `{held:false, helpOpen:false}` and records `POST /api/internal/computer/journal`:
```ts
it("journals each tools/call before the engine sees its reply, and forwards anyway when the journal is slow", async () => {
  // connection = gatedLocalComputer(original, control); spawn with { ...connection.env, OMB_COMPUTER_JOURNAL: "1" }
  // 1. journal route answers after 300 ms: the reply line arrives after the POST was received (record both timestamps).
  // 2. POST body: { tool: "anything", arguments: {...}, result: { isError: false, ... } } and carries Authorization: Bearer <control token>.
  // 3. journal route never answers: the reply still arrives within 1 500 ms.
  // 4. without OMB_COMPUTER_JOURNAL the route is never called.
});
```

`local-computer.test.ts:99`: add `OMB_COMPUTER_JOURNAL: "1"` to the expected `gated.env`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run server/saved-steps/driver-wire.test.ts server/saved-steps/journal-tap.test.ts server/local-computer-proxy.test.ts server/local-computer.test.ts`
Expected: FAIL (missing modules; proxy case never sees a POST; env mismatch).

- [ ] **Step 3: Implement**

`driver-wire.ts` and `journal-tap.ts` as the interfaces say. The tap keeps `id → {tool, arguments}` for inbound `tools/call` frames (`arguments` defaults to `{}`) and deletes it on the answer. `postJournal` sends `authorization: Bearer <token>`, JSON body, the caller's signal.

`runMcpBridge`: when `options.journal` is set, build one tap, call `tap.request(line)` in the inbound splitter before `intercept(line)`, and send both `answer` lines and the child's rewritten lines through one serialized writer, `reply(raw, written)`, that awaits `tap.response(raw)` before `process.stdout.write(written + "\n")`. The tap reads the child's raw line (before `toolLists.rewriteResponse`, `localComputerResultLine`, `textOnlyErrorResultLine`), so it sees `structuredContent` intact. Without `journal` the writes stay synchronous and unchanged.

`local-computer-proxy.ts`: destructure `OMB_COMPUTER_JOURNAL` out of `process.env` with the other `OMB_*` variables (the driver never receives it) and pass `journal: { url: journalUrl(url), token }` when it equals `"1"`.

`gatedLocalComputer`: add `OMB_COMPUTER_JOURNAL: "1"` to `env`.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run server/saved-steps/driver-wire.test.ts server/saved-steps/journal-tap.test.ts server/local-computer-proxy.test.ts server/local-computer.test.ts server/mcp-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/driver-wire.ts server/saved-steps/journal-tap.ts server/saved-steps/*.test.ts server/mcp-bridge.ts server/local-computer-proxy.ts server/local-computer.ts server/local-computer-proxy.test.ts server/local-computer.test.ts
git commit -m "feat(saved-steps): the host computer bridge journals each call before the engine sees it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Server journal, internal route and gate count

**Files:**
- Create: `server/saved-steps/journal.ts`, `server/routes/computer-journal.ts`, `server/saved-steps/saved-steps.ts`
- Modify: `server/index.ts:88` (import, same line), `server/index.ts:1539` (one new line before it), `server/index.ts:13382`, `server/index.ts:13563`, `server/index.ts:15051`
- Test: `server/saved-steps/journal.test.ts`, `server/routes/computer-journal.test.ts`

**Interfaces:**
- Consumes: `JournalEntry`, `COMPUTER_JOURNAL_PATH` (Task 2).
- Produces (journal.ts):
  - `interface JournalScope { botId: string; threadId: string; generation: string }`
  - `type JournalCapability = JournalScope & { kind: string; localVmTarget?: unknown; boxId?: string | null; teamComputerId?: string }`
  - `hostScope(capability: JournalCapability): JournalScope | null` (non-null only for `kind === "computer"` with no `localVmTarget`, `boxId === undefined`, no `teamComputerId`)
  - `parseJournalEntry(body: unknown): JournalEntry | null` (`tool` matches `/^[a-z_][a-z0-9_]{0,63}$/`, `arguments` a plain object, `result.isError` a boolean)
  - `interface RecordedCall extends JournalEntry { generation: string }`
  - `interface RequestJournal { calls: RecordedCall[]; complete: boolean; tainted: boolean }`
  - `class ComputerJournal { constructor(limits?: { callsPerThread?: number; threads?: number }); gateChecked(scope: JournalScope): void; record(scope: JournalScope, entry: JournalEntry): void; taint(scope: Pick<JournalScope, "threadId" | "generation">): void; take(threadId: string, generations: ReadonlySet<string>): RequestJournal | null }` (defaults 400 calls per thread, 64 threads, oldest thread evicted)
- Produces (routes/computer-journal.ts): `createComputerJournalRoutes(deps: { capability: JournalCapability; readBody(): Promise<unknown>; record(scope: JournalScope, entry: JournalEntry): void }): RouteHandler`
- Produces (saved-steps.ts, grown by Tasks 8-10): `createSavedSteps(deps: SavedStepsDeps): SavedSteps` with `SavedSteps.journal: ComputerJournal`, `SavedSteps.gateChecked(capability: JournalCapability): void`, `SavedSteps.journalRoutes(internal: { capability: JournalCapability; readBody(): Promise<unknown> }): RouteHandler`; re-exports `COMPUTER_JOURNAL_PATH`.

- [ ] **Step 1: Write the failing tests**

`journal.test.ts`:
```ts
const scope = { botId: "b1", threadId: "t1", generation: "g1" };
it("returns the request's calls in order with the generation they ran in", () => { /* 2 checks, 2 records -> calls[0].tool, calls[1].tool, complete true */ });
it("is incomplete when a gated call never journals", () => {
  const j = new ComputerJournal(); j.gateChecked(scope); j.gateChecked(scope); j.record(scope, CLICK);
  expect(j.take("t1", new Set(["g1"]))!.complete).toBe(false);
});
it("is incomplete when an entry arrives with no gate check behind it", () => { /* 0 checks, 1 record -> complete false */ });
it("is incomplete past the per-thread cap", () => { /* callsPerThread: 2, three calls -> complete false */ });
it("keeps two turns of one request together and drops other requests' leftovers", () => {
  // g0 (earlier request) + g1 + g2; take("t1", new Set(["g1","g2"])) -> only g1/g2 calls; a second take -> null
});
it("taints only the named generation", () => { /* taint g1 -> tainted true for {g1}; a fresh take for {g2} -> tainted false */ });
it("journals only this computer's turns", () => {
  expect(hostScope({ ...scope, kind: "computer" })).toEqual(scope);
  expect(hostScope({ ...scope, kind: "computer", boxId: null })).toBeNull();
  expect(hostScope({ ...scope, kind: "computer", localVmTarget: {} })).toBeNull();
  expect(hostScope({ ...scope, kind: "computer", teamComputerId: "tc" })).toBeNull();
  expect(hostScope({ ...scope, kind: "browser" })).toBeNull();
});
it("rejects malformed entries", () => { /* tool "../x", arguments [], result {} -> null */ });
```

`routes/computer-journal.test.ts` (same harness as `server/routes/reactions.test.ts`):
```ts
it("records a host turn's entry", async () => { /* POST COMPUTER_JOURNAL_PATH -> 200 {ok:true}; record called with scope and entry */ });
it("refuses a Local VM or cloud turn with 403", async () => {});
it("answers 400 to a malformed body", async () => {});
it("passes other paths and methods", async () => {});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run server/saved-steps/journal.test.ts server/routes/computer-journal.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`ComputerJournal` keeps per thread `{ calls: RecordedCall[]; checks: Map<generation, number>; recorded: Map<generation, number>; tainted: Set<generation>; overflow: Set<generation> }`. `take` filters to the given generations, sets `complete` when every generation seen in either map has equal counts and no overflow, `tainted` when any is tainted, deletes the thread, and returns `null` when nothing was seen for those generations.

The route reads the body only after `hostScope` passes. Put this comment on the route (a known open risk, allowed by `AGENTS.md`): the bearer reaches the engine with the bridge's environment, so an engine that reads it can add entries; the gate-check count and the saveability rules bound what a forged entry can make a replay do.

`saved-steps.ts`: `export function createSavedSteps(deps: SavedStepsDeps = {}): SavedSteps` with `interface SavedStepsDeps { now?: () => number }` for now.

`server/index.ts`, each edit on an existing line unless stated:
- line 88: append `import { COMPUTER_JOURNAL_PATH, createSavedSteps } from "./saved-steps/saved-steps.ts";`
- new line before 1539: `const savedSteps = createSavedSteps({});`
- line 13382: `: path === "/api/internal/computer-control" || path === "/api/internal/computer/mcp" || path === COMPUTER_JOURNAL_PATH`
- line 13563: prefix `if (await dispatchRoutes([savedSteps.journalRoutes({ capability: internalCapability, readBody: readInternalBody })], { req, res, url, path, method, auth, json, readBody })) return; `
- line 15051: `if (method === "GET") { savedSteps.gateChecked(internalCapability);`

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run server/saved-steps/journal.test.ts server/routes/computer-journal.test.ts scripts/testing/index-route-ratchet.test.ts scripts/testing/file-size-ratchet.test.ts && pnpm typecheck`
Expected: PASS; `server/index.ts` at 16171 lines.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/journal.ts server/saved-steps/journal.test.ts server/saved-steps/saved-steps.ts server/routes/computer-journal.ts server/routes/computer-journal.test.ts server/index.ts
git commit -m "feat(saved-steps): keep the host computer's journal per request and count its gated calls" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Saveability rules and the recipe builder

**Files:**
- Create: `server/saved-steps/rules.ts`, `server/testing/saved-steps-fixtures.ts`
- Test: `server/saved-steps/rules.test.ts`

**Interfaces:**
- Consumes: Task 1 functions; `WireElement`, `elementPath`, `SlimStructured` (Task 2); `RequestJournal`, `RecordedCall` (Task 3); `Message` from `server/store.ts`.
- Produces:
  - `type ActionTool = "click" | "double_click" | "right_click" | "type_text" | "set_value" | "press_key" | "scroll" | "launch_app" | "bring_to_front" | "hotkey"`
  - `const OBSERVATION_TOOLS: ReadonlySet<string>` = `get_window_state, list_apps, list_windows, get_accessibility_tree, get_desktop_state, get_screen_size, get_cursor_position, get_agent_cursor_state, get_session_state, check_permissions, screenshot`
  - `interface AppIdentity { bundleId?: string; name?: string }`, `interface ElementIdentity { role: string; label: string; path: string[] }`
  - `interface RecipeStep { tool: ActionTool; args: Record<string, unknown>; app?: AppIdentity; window?: { title: string }; element?: ElementIdentity }`
  - `interface Recipe { id: string; key: string; request: string; reply: string; steps: RecipeStep[]; createdAt: number; lastUsedAt: number }`
  - `type Refusal = "moment-words" | "several-turns" | "incomplete-journal" | "denied" | "tool-error" | "unknown-tool" | "pixel-or-drag" | "extra-arguments" | "unknown-target" | "stale-element" | "unlabelled-element" | "typed-text-not-in-request" | "url-not-in-request" | "no-steps" | "too-many-steps" | "no-reply"`
  - `buildRecipe(input: { request: string; reply: string; journal: RequestJournal; id: string; now: number }): { ok: true; recipe: Recipe } | { ok: false; reason: Refusal }`
  - `recipeFitsRequest(recipe: Recipe, request: string): boolean`
  - `personTextRequest(message: Message): boolean`
  - `stepLabel(step: RecipeStep): string`
- Produces (fixtures): `textEditJournal(overrides?: { calls?: RecordedCall[]; complete?: boolean; tainted?: boolean }): RequestJournal` and `windowState(snapshot: number): SlimStructured` (TextEdit pid 4242, bundle `com.apple.TextEdit`, window 7 "Untitled"; elements e0 `AXWindow` "Untitled", e1 `AXScrollArea` no label parent 0, e2 `AXTextArea` "Document" parent 1, e3 `AXButton` "Save" parent 0; tokens `s<snapshot>-e<i>`). The default journal: `list_apps`, `list_windows {pid:4242}`, `get_window_state {pid:4242, window_id:7}` (snapshot 1), `click {element_token:"s1-e2"}`, `type_text {element_token:"s1-e2", text:"hello world"}`, all generation `g1`, complete.

- [ ] **Step 1: Write the failing test**

```ts
const REQUEST = "Open TextEdit and type hello world";
const build = (journal = textEditJournal(), request = REQUEST, reply = "Typed hello world into TextEdit. Done.") =>
  buildRecipe({ request, reply, journal, id: "r1", now: 1_000 });

it("saves the TextEdit run with targets by identity", () => {
  const out = build(); if (!out.ok) throw new Error(out.reason);
  const target = { app: { bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { title: "Untitled" },
    element: { role: "AXTextArea", label: "Document", path: ["AXWindow:Untitled", "AXScrollArea:"] } };
  expect(out.recipe).toEqual({ id: "r1", key: "open textedit and type hello world", request: REQUEST, reply: "Typed hello world into TextEdit.",
    createdAt: 1_000, lastUsedAt: 1_000, steps: [{ tool: "click", args: {}, ...target }, { tool: "type_text", args: { text: "hello world" }, ...target }] });
  expect(JSON.stringify(out.recipe)).not.toMatch(/s1-e2|4242|"window_id"/);
});
it.each([
  ["moment-words", () => build(textEditJournal(), "type hello world here")],
  ["incomplete-journal", () => build(textEditJournal({ complete: false }))],
  ["denied", () => build(textEditJournal({ tainted: true }))],
  ["several-turns", () => build(withCall({ ...CLICK_S1_E2, generation: "g2" }))],
  ["tool-error", () => build(withCall(observation("list_windows", { isError: true })))],
  ["tool-error", () => build(withCall(observation("list_windows", { isError: true, rpcError: true })))],
  ["tool-error", () => build(withCall(observation("get_window_state", { isError: false, structured: { refusal: { code: "x" } } })))],
  ["unknown-tool", () => build(withCall(action("run_steps", {})))],
  ["pixel-or-drag", () => build(withCall(action("click", { x: 10, y: 20 })))],
  ["pixel-or-drag", () => build(withCall(action("drag", {})))],
  ["pixel-or-drag", () => build(withCall(action("browser_click", {})))],
  ["extra-arguments", () => build(withCall(action("launch_app", { name: "TextEdit", additional_arguments: ["--x"] })))],
  ["unknown-target", () => build(withCall(action("click", { element_token: "never-seen" })))],
  ["unknown-target", () => build(withCall(action("type_text", { text: "hello world", pid: 4242 })))],
  ["stale-element", () => build(snapshotThenClick({ refreshBeforeClick: true, token: "s1-e2" }))],
  ["unlabelled-element", () => build(withCall(action("click", { element_token: "s1-e1" })))],
  ["typed-text-not-in-request", () => build(withCall(action("type_text", { element_token: "s1-e2", text: "goodbye" })))],
  ["url-not-in-request", () => build(withCall(action("launch_app", { name: "Safari", urls: ["https://example.com"] })))],
  ["no-steps", () => build(observationsOnly())],
  ["too-many-steps", () => build(clicks(41))],
  ["no-reply", () => build(textEditJournal(), REQUEST, "  ")],
])("refuses: %s", (reason, run) => expect(run()).toEqual({ ok: false, reason }));
it("accepts a launch_app whose URLs are in the request", () => { /* "Open https://example.com in Safari" */ });
it("addresses element_index through the latest snapshot of its window", () => { /* click {element_index:3, window_id:7} -> element Save */ });
it("checks a recipe's typed text against new words", () => {
  const recipe = (build() as { ok: true; recipe: Recipe }).recipe;
  expect(recipeFitsRequest(recipe, "PLEASE open TextEdit and type HELLO WORLD")).toBe(true);
  expect(recipeFitsRequest(recipe, "open textedit and type hello, world")).toBe(false);
});
it.each([
  [{}, true], [{ via: "call" }, false], [{ relayed: true }, false], [{ replyToId: "m0" }, false], [{ dataContext: { cardId: "c" } }, false],
  [{ fromApp: {} }, false], [{ pointed: [] }, false], [{ peerAsk: {} }, false], [{ setupRequest: true }, false], [{ steered: true }, false],
  [{ attachments: [{ kind: "file", path: "/a", mime: "text/plain", name: "a" }] }, false], [{ text: 'see <attached-image path="/a.png" />' }, false],
])("person text request %#", (extra, expected) =>
  expect(personTextRequest({ id: "u1", at: 1, role: "user", kind: "text", text: REQUEST, ...extra } as Message)).toBe(expected));
```

`withCall`, `action`, `observation`, `snapshotThenClick`, `observationsOnly`, `clicks` are small helpers in the test file built on `textEditJournal`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/rules.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `rules.ts`**

`buildRecipe`, in this order:
1. `hasMomentWords(request)` → `moment-words`; `!journal.complete` → `incomplete-journal`; `journal.tainted` → `denied`; more than one distinct `generation` → `several-turns`; `firstSentence(reply)` null → `no-reply`.
2. Walk `calls` in order, keeping `appsByPid` (from `list_apps` `apps[]` with `running !== false`, `launch_app` result `pid`/`bundle_id`/`name` falling back to its arguments, `get_window_state` `pid`/`app_name`, `list_windows` `windows[].pid`/`app_name`; a later source fills missing fields, never overwrites), `windowsById` (`list_windows` titles, `get_window_state` `window_title`), `latestByWindow` (the latest `get_window_state` per `window_id`) and `seenTokens` (every token ever returned).
3. Any call with `result.isError`, `rpcError` or `structured.refusal` → `tool-error`. Observation tools contribute only to the indexes.
4. A tool named `drag`, `move_cursor`, `zoom` or starting `browser_`, or any call with `x` or `y` in its arguments → `pixel-or-drag`. Any other tool not in `ActionTool` → `unknown-tool`.
5. Arguments: `element_token`, `element_index`, `pid`, `window_id`, `session` address the call and are dropped; the rest must be in the tool's kept set, else `extra-arguments`:
   `click: button, count, modifier, action, delivery_mode, scope` · `double_click: delivery_mode` · `right_click: modifier, delivery_mode` · `type_text: text, delay_ms, delivery_mode, scope` · `set_value: value` · `press_key: key, modifiers, delivery_mode, scope` · `scroll: direction, amount, by, delivery_mode, scope` · `hotkey: keys, delivery_mode, scope` · `launch_app: bundle_id, name, urls, creates_new_application_instance` · `bring_to_front: (none)`.
6. Element tools (`click`, `double_click`, `right_click`, `type_text`, `set_value`, `scroll`, and `press_key` when it carries a token or index): `element_token` must be in the latest snapshot of some window (in `seenTokens` only → `stale-element`; nowhere → `unknown-target`); `element_index` resolves in `latestByWindow.get(window_id)`, else the latest snapshot whose `pid` matches; no token and no index → `unknown-target`. Empty label → `unlabelled-element`; `elementPath` null → `unknown-target`. Identity: `element {role, label, path}`, `app` from `appsByPid` of the snapshot's pid (else `{name: app_name}`; neither → `unknown-target`), `window {title: window_title}` when it has one.
7. `bring_to_front`, and `hotkey`/`press_key` with a `pid`: app from `appsByPid` (missing → `unknown-target`), window from `windowsById` when a `window_id` was given. Without `pid` they keep no target.
8. `type_text.text` and `set_value.value` must pass `inRequest` → else `typed-text-not-in-request`; every `launch_app` URL must pass `inRequest` → else `url-not-in-request`.
9. Zero actions → `no-steps`; more than 40 → `too-many-steps`.

`recipeFitsRequest`: every `type_text` text, `set_value` value and `launch_app` URL passes `inRequest(…, request)`.

`personTextRequest`: `role === "user"`, `kind === "text"`, non-blank `text` without `<attached-image` or `<attached-file`, and none of `attachments` (non-empty), `replyToId`, `reaction`, `fromApp`, `pointed`, `dataContext`, `peerAsk`, `via`, `relayed`, `setupRequest`, `steered`, `aside`.

`stepLabel`: element → `"<label>" in <app name or bundle id>`; else window title; else app name or bundle id; `launch_app` → its `name` or `bundle_id`; else `the screen`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/saved-steps/rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/rules.ts server/saved-steps/rules.test.ts server/testing/saved-steps-fixtures.ts
git commit -m "feat(saved-steps): saveability rules turn a request's journal into a recipe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Recipe store

**Files:**
- Create: `server/saved-steps/store.ts`
- Test: `server/saved-steps/store.test.ts`

**Interfaces:**
- Consumes: `Recipe` (Task 4); `writeFileAtomic` (`server/atomic.ts:57`).
- Produces: `const MAX_RECIPES = 200`, `const UNUSED_MS = 60 * 24 * 60 * 60 * 1000`, `class RecipeStore { constructor(options: { folder: (botId: string) => string; now?: () => number }); find(botId: string, key: string): Recipe | undefined; save(botId: string, recipe: Recipe): void; touch(botId: string, recipeId: string): void; forget(botId: string, recipeId: string): boolean }`. The file is `<folder>/saved-steps.json` holding `{ "version": 1, "recipes": Recipe[] }`.

- [ ] **Step 1: Write the failing test** (each case in a fresh `mkdtempSync` folder)

```ts
it("saves and finds by key, in a 0600 file", () => {
  store.save("b1", recipe("r1", "open notes"));
  expect(store.find("b1", "open notes")!.id).toBe("r1");
  expect(statSync(join(dir, "b1", "saved-steps.json")).mode & 0o777).toBe(0o600);
});
it("replaces the recipe for the same key", () => { /* r1 then r2 with one key -> find returns r2; file holds one recipe */ });
it("keeps the 200 most recently used", () => { /* 201 saves with rising lastUsedAt -> the oldest is gone */ });
it("drops a recipe unused for 60 days", () => { /* now = lastUsedAt + UNUSED_MS + 1 -> find undefined; after any save the file no longer holds it */ });
it("touch moves lastUsedAt to now", () => {});
it("forget answers whether it removed something", () => { expect(store.forget("b1", "r1")).toBe(true); expect(store.forget("b1", "r1")).toBe(false); });
it("reads a corrupt or other-version file as empty and rewrites it on save", () => {
  writeFileSync(file, "{nope"); expect(store.find("b1", "open notes")).toBeUndefined();
  store.save("b1", recipe("r1", "open notes")); expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
  writeFileSync(file, JSON.stringify({ version: 2, recipes: [] })); expect(store.find("b1", "open notes")).toBeUndefined();
});
it("drops malformed recipes and keeps the rest", () => { /* one with steps: "x", one valid -> only the valid one is found */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/store.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `store.ts`**

Read the file on each call (no cache); validate with a zod schema of `Recipe` (each recipe parsed alone with `safeParse`, failures dropped); drop recipes older than `UNUSED_MS`. Writes: `mkdirSync(folder, { recursive: true, mode: 0o700 })`, then `writeFileAtomic(path, JSON.stringify(file), { mode: 0o600 })`, only when something changed. `save` keeps at most `MAX_RECIPES`, evicting the lowest `lastUsedAt`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/saved-steps/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/store.ts server/saved-steps/store.test.ts
git commit -m "feat(saved-steps): per-bot recipe store with caps and expiry" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Target resolver

**Files:**
- Create: `server/saved-steps/resolve.ts`
- Test: `server/saved-steps/resolve.test.ts`

**Interfaces:**
- Consumes: `RecipeStep`, `AppIdentity`, `ElementIdentity`, `stepLabel` (Task 4); `WireElement`, `elementPath` (Task 2); fixtures (Task 4).
- Produces:
  - `type CallOutcome = { ok: true; structured: Record<string, unknown> } | { ok: false; error: string }`
  - `interface ComputerCaller { call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallOutcome> }`
  - `type Match<T> = { ok: true; value: T } | { ok: false; reason: "none" | "ambiguous" }`
  - `matchApp(apps: unknown, app: AppIdentity): Match<number>` (pid)
  - `matchWindow(windows: unknown, pid: number, window: { title: string } | undefined): Match<number>` (window id)
  - `matchElement(elements: unknown, element: ElementIdentity): Match<WireElement>`
  - `resolveStep(step: RecipeStep, caller: ComputerCaller, signal: AbortSignal): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; error: string }>`

- [ ] **Step 1: Write the failing test** (fake `ComputerCaller` answering `list_apps`, `list_windows`, `get_window_state` from fixtures, recording each call)

```ts
it("resolves an element step afresh, without a screenshot", async () => {
  expect(await resolveStep(CLICK_DOCUMENT, caller(windowState(2)), signal)).toEqual({ ok: true, args: { pid: 4242, window_id: 7, element_token: "s2-e2" } });
  expect(calls.at(-1)).toEqual(["get_window_state", { pid: 4242, window_id: 7, include_screenshot: false }]);
});
it("addresses by index when the snapshot has no tokens", async () => { /* -> { pid, window_id, element_index: 2 } */ });
it("prefers bundle id over name", () => expect(matchApp([{ pid: 1, name: "Notes", bundle_id: "a" }, { pid: 2, name: "Notes", bundle_id: "b" }], { bundleId: "b", name: "Notes" })).toEqual({ ok: true, value: 2 }));
it("never picks an app that is not running", () => expect(matchApp([{ pid: 0, name: "TextEdit", running: false }], { name: "TextEdit" })).toEqual({ ok: false, reason: "none" }));
it("takes the only window when the title changed", () => expect(matchWindow([{ window_id: 9, pid: 4242, title: "Untitled 2" }], 4242, { title: "Untitled" })).toEqual({ ok: true, value: 9 }));
it("refuses two windows when none has the title", () => expect(matchWindow([{ window_id: 8, pid: 4242, title: "A" }, { window_id: 9, pid: 4242, title: "B" }], 4242, { title: "Untitled" })).toEqual({ ok: false, reason: "ambiguous" }));
it("refuses duplicate labels on the same path", () => { /* two AXButton "Save" under AXWindow:Untitled -> ambiguous */ });
it("fails a renamed element with words a person can read", async () => {
  expect(await resolveStep(CLICK_DOCUMENT, caller(renamed), signal)).toEqual({ ok: false, error: 'no "Document" (AXTextArea) in Untitled' });
});
it("passes a caller failure through", async () => { /* list_apps ok:false error "boom" -> { ok:false, error:"boom" } */ });
it("needs no lookups for launch_app", async () => { /* calls stays empty; args equal step.args */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/resolve.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `resolve.ts`**

`matchApp`: candidates with `pid > 0` and `running !== false`; by `bundle_id` when the identity has one, else by exact `name`. `matchWindow`: windows of `pid`; a unique exact title wins; with no exact title (or no saved window) the pid's only window wins; else `ambiguous` (several) or `none`. `matchElement`: role, label and `elementPath` all equal.

`resolveStep`: `launch_app` → `step.args`. With `step.app`: `list_apps` → pid. Element steps and steps with `step.window`: `list_windows {pid}` → window id. Element steps: `get_window_state {pid, window_id, include_screenshot: false}` → element; args `{...step.args, pid, window_id, element_token}`, or `element_index` when the element has no token. `hotkey`/`press_key` without `step.app` → `step.args`. Error words: `<app> is not running`, `more than one <app> app is running`, `no window titled "<title>"`, `more than one window of <app>`, `no "<label>" (<role>) in <window or app>`, `more than one "<label>" (<role>) in <window or app>`.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/saved-steps/resolve.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/resolve.ts server/saved-steps/resolve.test.ts
git commit -m "feat(saved-steps): resolve a saved step's target on the live screen" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Computer caller and step runner

**Files:**
- Create: `server/saved-steps/computer-client.ts`, `server/saved-steps/replay.ts`
- Modify: `server/drivers/chat-mcp-tools.ts:70` (`class ChatMcpClient` → `export class ChatMcpClient`)
- Test: `server/saved-steps/computer-client.test.ts`, `server/saved-steps/replay.test.ts`

**Interfaces:**
- Consumes: `ComputerCaller`, `CallOutcome`, `resolveStep` (Task 6); `Recipe`, `stepLabel` (Task 4); `ChatMcpClient` (`call(method, params, signal, timeout)`, `tools(signal)`, `close()`); `RuntimeEvent`, `newId` (`server/contracts.ts`).
- Produces (computer-client.ts):
  - `const STEP_TIMEOUT_MS = 60_000`
  - `type LocalComputerSpec = { command: string; args: string[]; env: Record<string, string> }`
  - `openComputerCaller(computer: LocalComputerSpec, signal: AbortSignal): Promise<ComputerCaller & { close(): Promise<void> }>`
  - `callOutcome(result: unknown): CallOutcome`
- Produces (replay.ts):
  - `interface ReplayTurn { threadId: string; turnId: string; provider: string; providerInstanceId: string }`
  - `interface StepApproval { ask(tool: string, summary: string): Promise<boolean> }`
  - `type ReplayOutcome = { kind: "done" } | { kind: "declined"; tool: string; label: string } | { kind: "failed"; done: number; total: number; tool: string; label: string; error: string } | { kind: "stopped" }`
  - `runSteps(recipe: Recipe, turn: ReplayTurn, deps: { caller: ComputerCaller; approval: StepApproval; publish(event: RuntimeEvent): void; signal: AbortSignal }): Promise<ReplayOutcome>`
  - `fallbackNote(outcome: Extract<ReplayOutcome, { kind: "failed" }>): string`
  - `declinedReply(outcome: Extract<ReplayOutcome, { kind: "declined" }>): string`

- [ ] **Step 1: Write the failing tests**

`computer-client.test.ts`:
```ts
it("calls a tool through MCP after the handshake", async () => {
  // server/testing/fake-mcp-server.ts with FAKE_MCP_CALL_FILE in its env
  const caller = await openComputerCaller({ command: process.execPath, args: ["--experimental-strip-types", FAKE], env: { FAKE_MCP_CALL_FILE: file } }, signal);
  expect(await caller.call("click", { element_token: "s2-e2" }, signal)).toEqual({ ok: true, structured: {} });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "click", arguments: { element_token: "s2-e2" } });
  await caller.close();
});
it.each([
  [{ content: [{ type: "text", text: "A person has taken control" }], isError: true }, { ok: false, error: "A person has taken control" }],
  [{ content: [], structuredContent: { refusal: { code: "x", message: "not allowed" } } }, { ok: false, error: "not allowed" }],
  [{ content: [], structuredContent: { pid: 1 } }, { ok: true, structured: { pid: 1 } }],
  ["junk", { ok: false, error: "the computer returned an invalid result" }],
])("callOutcome %#", (result, expected) => expect(callOutcome(result)).toEqual(expected));
```

`replay.test.ts` (a fake caller whose `get_window_state` answers `windowState(n)` with `n` rising from 2 and which records action calls in `acted`; a fake approval recording asks; `publish` into an array):
```ts
it("asks once per action, resolves afresh and reports each step", async () => {
  expect(await runSteps(RECIPE, TURN, deps)).toEqual({ kind: "done" });
  expect(asked).toEqual([["mcp__computer__click", 'click on "Document" in TextEdit'], ["mcp__computer__type_text", 'type_text on "Document" in TextEdit']]);
  expect(acted).toEqual([["click", { pid: 4242, window_id: 7, element_token: "s2-e2" }], ["type_text", { text: "hello world", pid: 4242, window_id: 7, element_token: "s3-e2" }]]);
  expect(events.map((e) => [e.type, e.turnId, "ok" in e ? e.ok : undefined])).toEqual([
    ["item.started", "turn-1", undefined], ["item.completed", "turn-1", true], ["item.started", "turn-1", undefined], ["item.completed", "turn-1", true]]);
});
it("stops at a declined step without acting", async () => {
  expect(await runSteps(RECIPE, TURN, { ...deps, approval: denyAt(2) })).toEqual({ kind: "declined", tool: "type_text", label: '"Document" in TextEdit' });
  expect(acted.map(([tool]) => tool)).toEqual(["click"]);
});
it("reports how far it got when a step fails", async () => {
  const out = await runSteps(RECIPE, TURN, { ...deps, caller: failing("type_text", "Fixture failure.") });
  expect(out).toEqual({ kind: "failed", done: 1, total: 2, tool: "type_text", label: '"Document" in TextEdit', error: "Fixture failure." });
  expect(fallbackNote(out as never)).toBe('A saved run of this request did steps 1–1 of 2 and failed at step 2 (type_text on "Document" in TextEdit): Fixture failure. The screen may already be partly changed; look before acting.');
});
it("words a failure at the first step", () => expect(fallbackNote({ kind: "failed", done: 0, total: 2, tool: "click", label: '"Document" in TextEdit', error: "TextEdit is not running" }))
  .toBe('A saved run of this request failed at step 1 of 2 (click on "Document" in TextEdit): TextEdit is not running. The screen may already be partly changed; look before acting.'));
it("stops when the signal aborts during an approval", async () => { /* abort while ask pending -> { kind: "stopped" }; acted empty */ });
it("says what was declined", () => expect(declinedReply({ kind: "declined", tool: "type_text", label: '"Document" in TextEdit' }))
  .toBe('I stopped repeating the saved steps: type_text on "Document" in TextEdit was declined.'));
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run server/saved-steps/computer-client.test.ts server/saved-steps/replay.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`openComputerCaller`: `new ChatMcpClient(computer, true)`, `await client.tools(signal)` for the handshake, then each `call` is `client.call("tools/call", { name, arguments }, signal, STEP_TIMEOUT_MS)` passed through `callOutcome`; a thrown error becomes `{ ok: false, error: message }`. `callOutcome`: `isError` → the text items joined (first 300 characters, or `the tool reported an error`); `structuredContent.refusal` → its `message` or `code`; not an object with a `content` array → `the computer returned an invalid result`.

`runSteps`, per step `i`: aborted → `stopped`; `resolveStep` failure → `failed { done: i }`; `approval.ask("mcp__computer__" + tool, tool + " on " + stepLabel(step))` false → `stopped` when aborted, else `declined`; publish `item.started { itemType: "tool", itemId, title: "mcp__computer__" + tool, input: <same summary> }`; call; failure → publish `item.completed { itemType: "tool", ok: false, output: error }` and return `failed`; success → `item.completed { ok: true, output: "done" }`. Every event carries `eventId: newId()`, `createdAt`, and the turn's `threadId`, `turnId`, `provider`, `providerInstanceId`. `fallbackNote` strips trailing dots and spaces from the error before adding its own period.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run server/saved-steps/computer-client.test.ts server/saved-steps/replay.test.ts server/drivers/chat-mcp-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/computer-client.ts server/saved-steps/replay.ts server/saved-steps/computer-client.test.ts server/saved-steps/replay.test.ts server/drivers/chat-mcp-tools.ts
git commit -m "feat(saved-steps): run saved steps through the gated computer with an approval per action" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dispatch wrapper, setting flag and engine wiring

**Files:**
- Create: `server/saved-steps/dispatch.ts`
- Modify: `server/saved-steps/saved-steps.ts`; `server/config.ts:262` and `server/config.ts:519` (same lines); `server/index.ts:88`, `1539` (the line Task 3 added), `1539-1540` (now 1540-1541), `6699-6701`, `8654`, `8679-8680`, `12204`
- Test: `server/saved-steps/dispatch.test.ts`, `server/index.test.ts:9377,9387,9395`

**Interfaces:**
- Consumes: Tasks 1, 4, 5, 6, 7; `createChatToolApproval` (`server/drivers/chat-tool-approval.ts:25`); `ProviderInstance`, `ProviderAdapter`, `SendTurnInput`, `TurnStartResult`, `RuntimeEvent`, `newId` (`server/contracts.ts`).
- Produces (dispatch.ts):
  - `interface EngineSlots { get(threadId: string): ProviderInstance | undefined; set(threadId: string, engine: ProviderInstance): void }`
  - `interface ReplayRequest { botId: string; message: Message }`
  - `interface DispatchDeps { recipes: Pick<RecipeStore, "find" | "forget">; enabled(): boolean; publish(event: RuntimeEvent): void; engines: EngineSlots; stopped(threadId: string): boolean; openCaller(computer: LocalComputerSpec, signal: AbortSignal): Promise<ComputerCaller & { close(): Promise<void> }> }`
  - `class SavedStepsDispatch { constructor(deps: DispatchDeps); sendTurn(engine: ProviderInstance, request: ReplayRequest | null, input: SendTurnInput, start: (input: SendTurnInput) => Promise<TurnStartResult>): Promise<TurnStartResult>; take(event: RuntimeEvent): boolean; replayed(threadId: string, turnId: string): string | undefined }`
- Produces (saved-steps.ts): `savedStepsEnabled(cfg: Pick<AppConfig, "features">): boolean` (`features?.savedSteps !== false`); `SavedSteps.dispatch: SavedStepsDispatch`; `SavedSteps.recipes: RecipeStore`; `SavedStepsDeps` gains `enabled(): boolean; publish(event: RuntimeEvent): void; engines: EngineSlots; stopped(threadId: string): boolean; folder?: (botId: string) => string` (default `botFolder` from `server/bot-folder.ts`); the facade builds one `RecipeStore` and passes `openComputerCaller`.

- [ ] **Step 1: Write the failing test**

Fixture: an engine stub `{ instanceId: "claude", driverKind: "claudeAgent", adapter }` whose `sendTurn` must not be called on a replay; `start` a spy returning `{ turnId: "e1" }`; a store holding `RECIPE` under `requestKey(REQUEST)`; `openCaller` returning the Task 6 fake caller; `publish` collecting events and answering each replay `request.opened` as the Full-access handler would, through `engines.get(threadId).adapter.respondToRequest(threadId, requestId, { behavior: "allow" })`. `INPUT` has `approvalMode: "full"` and `integrations.localComputer.scope: "local-computer"`.

```ts
it.each([
  ["no request", null, INPUT], ["Ask", REQ, { ...INPUT, approvalMode: "ask" }], ["no host computer", REQ, { ...INPUT, integrations: {} }],
  ["spoken", { ...REQ, message: { ...REQ.message, via: "call" } }, INPUT], ["new words", { ...REQ, message: { ...REQ.message, text: "open textedit and type hello, world" } }, INPUT],
])("passes through: %s", async (_, request, input) => {
  expect(await dispatch.sendTurn(engine, request as never, input, start)).toEqual({ turnId: "e1" });
  expect(start).toHaveBeenCalledWith(input); expect(events).toEqual([]);
});
it("passes through while the setting is off", async () => { /* enabled() false -> start called */ });
it("answers a saved request with no engine call", async () => {
  const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start); await settled();
  expect(start).not.toHaveBeenCalled(); expect(engine.adapter.sendTurn).not.toHaveBeenCalled();
  expect(types()).toEqual(["turn.started", "request.opened", "request.resolved", "item.started", "item.completed", "request.opened", "request.resolved", "item.started", "item.completed", "item.completed", "turn.completed"]);
  expect(events.find((e) => e.type === "request.opened")).toMatchObject({ tool: "mcp__computer__click", approvalScope: "local-computer", allowSession: false, turnId });
  expect(events.at(-2)).toMatchObject({ itemType: "assistant_text", text: RECIPE.reply });
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, provider: "claudeAgent", providerInstanceId: "claude" });
  expect(dispatch.replayed("t1", turnId)).toBe(RECIPE.id);
});
it("stands in for the engine while it replays", async () => { /* during the run engines.get("t1") has instanceId "claude", its adapter is not engine.adapter, steer() resolves "refused" */ });
it("a declined step ends the turn without the AI and keeps the recipe", async () => {
  /* publish denies -> assistant_text === declinedReply(...); turn.completed { ok: true, denials: ["mcp__computer__type_text"] }; start not called; forget not called */
});
it("a failed step forgets the recipe and hands the request to the AI under the replay's turn id", async () => {
  const { turnId } = await dispatch.sendTurn(engine, REQ, INPUT, start); await settled();
  expect(recipes.forget).toHaveBeenCalledWith("b1", RECIPE.id);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][0].text).toBe(`${INPUT.text}\n\n${fallbackNote(FAILED)}`);
  expect(engines.get("t1")).toBe(engine);
  expect(dispatch.take(ev("turn.started", "e1"))).toBe(true);
  expect(dispatch.take(ev("item.completed", "e1"))).toBe(true);
  expect(dispatch.take(ev("turn.completed", "e1"))).toBe(true);
  expect(events.slice(-2).map((e) => [e.type, e.turnId])).toEqual([["item.completed", turnId], ["turn.completed", turnId]]);
  expect(dispatch.take(ev("item.completed", "e1"))).toBe(false);
});
it("appends the note to recoveryText too", async () => {});
it("Stop during a replay ends the turn interrupted", async () => {
  /* hold the approval; await engines.get("t1")!.adapter.interruptTurn("t1") -> last event turn.completed { ok: false, stopReason: "interrupted" }; start not called */
});
it("leaves other threads' and turns' events alone", () => expect(dispatch.take(ev("item.completed", "x", "t2"))).toBe(false));
```

In `server/index.test.ts` add `savedSteps: true` to the three `features` objects at lines 9377, 9387 and 9395.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/dispatch.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement `SavedStepsDispatch`**

`sendTurn` replays only when `request` is set, `enabled()`, `input.approvalMode === "full"`, `input.integrations?.localComputer?.scope === "local-computer"`, `personTextRequest(request.message)`, a recipe exists for `requestKey(request.message.text)` and `recipeFitsRequest` holds; otherwise it returns `start(input)`. A replay creates `turnId = newId()`, an `AbortController`, and an approval gate from `createChatToolApproval` whose `open` publishes `request.opened { requestType: "permission", requestId: ask.id, tool, summary, approvalScope: "local-computer", allowSession: false }` and whose `resolved` publishes `request.resolved { behavior, source, approvalScope: "local-computer" }` (question hooks are no-ops). It registers `engines.set(threadId, Object.create(engine, { adapter: { value: standIn } }))`, where `standIn` delegates every `ProviderAdapter` member to `engine.adapter` by explicit forwarding except `interruptTurn` (aborts the replay; delegates once the run is in fallback), `respondToRequest` (the gate's `answer` for its own request ids, else delegates) and `steer` (`"refused"`). It returns `{ turnId }` at once and starts the run in `setImmediate`, so dispatch binds the turn before any event.

The run publishes `turn.started`, opens the caller with `deps.openCaller(input.integrations.localComputer, signal)` (an open failure counts as `failed` at step 1), calls `runSteps`, closes the caller and the gate, then:
- `done`: `item.completed { itemType: "assistant_text", text: recipe.reply }`, `turn.completed { ok: true, stopReason: "end_turn" }`, remember `replayed(threadId, turnId)`.
- `declined`: `assistant_text` with `declinedReply`, `turn.completed { ok: true, stopReason: "end_turn", denials: ["mcp__computer__" + tool] }`.
- `stopped`: `turn.completed { ok: false, stopReason: "interrupted" }`.
- `failed`: `recipes.forget`, `engines.set(threadId, engine)`, phase `fallback`, `start({ ...input, text: input.text + "\n\n" + note, ...(input.recoveryText !== undefined ? { recoveryText: input.recoveryText + "\n\n" + note } : {}) })`; on resolve keep `sent.turnId` as the engine turn id and interrupt the engine when `stopped(threadId)`; on reject publish `runtime.error { message }` and `turn.completed { ok: false, stopReason: message }`.

`take` mirrors `QuickModelFallback.take`: only a thread in `fallback` with a `turnId`; the first foreign turn id becomes the engine's (unless `sendTurn` already gave it); the engine's `turn.started` is dropped; other events of that id are published with the replay's `turnId`; `turn.completed` ends the run.

`config.ts`: line 262 becomes `}).extend({ agentsToolBridge: z.boolean().optional(), savedSteps: z.boolean().optional() }); // agentsToolBridge: the find_tool / use_tool bridge, off unless true; savedSteps: repeat a computer task from its saved steps, on unless false`; line 519 gains `; savedSteps?: boolean` inside `features`.

`server/index.ts`, all on existing lines:
- line 88: add `savedStepsEnabled` to the Task 3 import.
- the `createSavedSteps({})` line: `createSavedSteps({ enabled: () => savedStepsEnabled(cfg), publish: (event) => bus.publish(event), engines: { get: (threadId) => runningTurnEngines.get(threadId), set: (threadId, engine) => { runningTurnEngines.set(threadId, engine); } }, stopped: (threadId) => directRequestOwners.get(threadId)?.stopped === true })` (closures only: `bus`, `runningTurnEngines` and `directRequestOwners` are declared later).
- `QuickModelFallback` line: `publish: (event) => { if (!savedSteps.dispatch.take(event)) bus.publish(event); }`.
- `EventBus` line: gate `(event) => quickFallback.take(event) || savedSteps.dispatch.take(event)`. QuickModelFallback stays the inner gate: a quick-model retry keeps its first turn id, which the replay then maps to its own.
- lines 6699-6701 become two lines (this is the line removed): `const instanceId = event.providerInstanceId ?? asker.modelSelection.instanceId; const running = runningTurnEngines.get(event.threadId);` and `const instance = running?.instanceId === instanceId ? running : registry.get(instanceId);`. The Full-access answer then reaches the stand-in; a normal turn's running engine is the registry's own instance, so nothing else changes.
- line 8654: `const dispatch = await guardTurnDispatch(shareNote.after(savedSteps.dispatch.sendTurn(instance, personLine && !opts?.unattended && !opts?.app?.context && !guestConfined ? { botId: bot.id, message: userMessage } : null, {`
- line 8679: `}, (input) => quickFallback.sendTurn(instance, input, route.quickModel ? { model, own: bot.modelSelection, onFallback: () => store.patchMessage(threadId, userMessage.id, { quickModel: undefined }) } : undefined))), () => !directTurnClaimExists(bot.id, dispatchClaimId, threadId), async () => {`
- line 8680: `await (runningTurnEngines.get(threadId) ?? instance).adapter.interruptTurn(threadId).catch(() => {});`
- line 12204: `llmThreadTitles: llmThreadTitlesEnabled(cfg), savedSteps: savedStepsEnabled(cfg),`

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run server/saved-steps/dispatch.test.ts server/quick-model-fallback.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts && pnpm exec vitest run server/index.test.ts -t "keeps skill authoring on by default" && pnpm exec vitest run server/full-access-workflows.e2e.test.ts server/full-access-default.e2e.test.ts server/host-lazy-claim.e2e.test.ts && pnpm typecheck`
Expected: PASS; `server/index.ts` at 16170 lines, `server/config.ts` at 1365.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/dispatch.ts server/saved-steps/dispatch.test.ts server/saved-steps/saved-steps.ts server/config.ts server/index.ts server/index.test.ts
git commit -m "feat(saved-steps): replay a saved request in place of the engine, falling back with a note" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Save on success and mark the reply

**Files:**
- Modify: `server/saved-steps/saved-steps.ts`, `shared/wire.ts:551` (after `turnCompletedAt`), `server/index.ts:4765` (same line), `server/index.ts` (one new line after `bus.attach(registry.instances());`)
- Test: `server/saved-steps/saved-steps.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 5, 8.
- Produces:
  - `WireMessage.savedSteps?: { recipeId: string; learned?: true; replayed?: true }` with a doc comment: set on the reply of a request whose steps were saved (`learned`) or which was answered from saved steps (`replayed`); clients that do not know it ignore it.
  - `interface SettledRequest { botId: string; threadId: string; request: Message; reply: Message; after: readonly Message[]; generations: ReadonlySet<string>; automated: boolean }`
  - `SavedSteps.requestSettled(settled: SettledRequest): void`, `SavedSteps.observe(event: RuntimeEvent): void`
  - `SavedStepsDeps` gains `patchMessage(threadId: string, messageId: string, patch: Partial<Message>): void` and `generation(threadId: string): string | undefined`.

- [ ] **Step 1: Write the failing test** (facade over a temp folder; the `record` helper calls `steps.journal.gateChecked(scope)` then `steps.journal.record(scope, entry)` for each fixture call)

```ts
it("saves a settled host run and marks the reply", () => {
  record(textEditJournal().calls);
  steps.requestSettled(settled());
  const saved = steps.recipes.find("b1", "open textedit and type hello world")!;
  expect(patches).toEqual([["t1", "reply-1", { savedSteps: { recipeId: saved.id, learned: true } }]]);
});
it("marks a replayed reply, touches its recipe and clears the quick model label", () => {
  /* dispatch.replayed("t1","turn-r") === "r1" -> patches: request {quickModel: undefined} (only when set), reply {savedSteps:{recipeId:"r1", replayed:true}}; lastUsedAt === now */
});
it.each([
  ["the setting is off", { enabled: false }], ["the request was automated", { automated: true }],
  ["a person line followed", { after: [{ role: "user", kind: "text", text: "faster" }] }],
  ["the request was spoken", { request: { via: "call" } }], ["nothing touched the computer", { calls: [] }],
])("saves nothing when %s", (_, change) => { /* recipes empty, patches empty */ });
it("a denial during the request stops it saving", () => {
  record(textEditJournal().calls);
  steps.observe({ type: "turn.completed", threadId: "t1", turnId: "x", ok: true, denials: ["Bash"] } as RuntimeEvent);
  steps.requestSettled(settled()); expect(patches).toEqual([]);
});
it("frees the journal even when it saves nothing", () => { /* enabled false, settle, then journal.take("t1", gens) === null */ });
```

`observe` taints `{ threadId, generation: deps.generation(threadId) }` on `request.resolved` with `behavior: "deny"` and on `turn.completed` with non-empty `denials`.

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/saved-steps/saved-steps.test.ts`
Expected: FAIL, `requestSettled` missing.

- [ ] **Step 3: Implement**

`requestSettled`: take the journal for `generations` first (always). A replayed reply (`dispatch.replayed(threadId, reply.turnId)`) → `recipes.touch`, clear `quickModel` on the request when set, patch the reply `{ savedSteps: { recipeId, replayed: true } }`, stop. Otherwise stop unless `enabled()`, `!automated`, the journal has calls, `personTextRequest(request)` and no `after` line has `role === "user"`; then `buildRecipe({ request: request.text, reply: reply.text ?? "", journal, id: randomUUID(), now })`, save, patch `{ savedSteps: { recipeId, learned: true } }`. Refusals are silent.

`server/index.ts`:
- line 4765: append ` savedSteps.requestSettled({ botId: bot.id, threadId, request: source, reply: terminal, after: messages, generations: owner.generations, automated: owner.automation !== undefined });`
- the `createSavedSteps` line gains `patchMessage: (threadId, messageId, patch) => { store.patchMessage(threadId, messageId, patch); }, generation: (threadId) => directTurnGenerationByThread.get(threadId)`.
- new line after `bus.attach(registry.instances());`: `bus.subscribe((event) => savedSteps.observe(event));`

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/saved-steps/saved-steps.test.ts scripts/testing/file-size-ratchet.test.ts && pnpm typecheck`
Expected: PASS; `server/index.ts` at 16171 lines.

- [ ] **Step 5: Commit**

```bash
git add server/saved-steps/saved-steps.ts server/saved-steps/saved-steps.test.ts shared/wire.ts server/index.ts
git commit -m "feat(saved-steps): save a request's steps when it settles and mark the reply" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Forget route

**Files:**
- Create: `server/routes/saved-steps.ts`
- Modify: `server/saved-steps/saved-steps.ts`, `server/index.ts` (one new line after the `createSavedSteps` line)
- Test: `server/routes/saved-steps.test.ts`

**Interfaces:**
- Consumes: `RecipeStore.forget` (Task 5).
- Produces: `createSavedStepsRoutes(deps: { bot(id: string): unknown; forget(botId: string, recipeId: string): boolean }): RouteHandler` for `DELETE /api/bots/:botId/saved-steps/:recipeId`; `SavedSteps.routes: RouteHandler`; `SavedStepsDeps` gains `bot(id: string): unknown`.

- [ ] **Step 1: Write the failing test** (harness as in `server/routes/reactions.test.ts`)

```ts
it("forgets a saved recipe", async () => expect(await del("/api/bots/b1/saved-steps/r1")).toEqual([200, { forgotten: true }]));
it("is idempotent for a recipe that is gone", async () => expect(await del("/api/bots/b1/saved-steps/r9")).toEqual([200, { forgotten: false }]));
it("answers 404 for an unknown bot", async () => expect((await del("/api/bots/zz/saved-steps/r1"))[0]).toBe(404));
it("answers 400 for a recipe id that is not an id", async () => expect((await del("/api/bots/b1/saved-steps/a.b"))[0]).toBe(400));
it("passes other methods and paths", async () => { /* GET same path -> "no route"; DELETE /api/bots/b1/saved-steps -> "no route" */ });
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/routes/saved-steps.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement**

Match `^/api/bots/([\w-]+)/saved-steps/([^/]+)$` on `DELETE`; recipe id must match `^[\w-]{1,64}$`. The facade exposes `routes = createSavedStepsRoutes({ bot: deps.bot, forget: (botId, id) => recipes.forget(botId, id) })`. In `server/index.ts` the `createSavedSteps` line gains `bot: (id) => store.bot(id)`, and the new line after it is `ROUTES.push(savedSteps.routes);`. The path stays out of `CLIENT_ALLOW` (`server/request-auth.ts:277`): only the owner and admins forget.

- [ ] **Step 4: Run it and see it pass**

Run: `pnpm exec vitest run server/routes/saved-steps.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/index-route-ratchet.test.ts && pnpm typecheck`
Expected: PASS; `server/index.ts` at 16172 lines.

- [ ] **Step 5: Commit**

```bash
git add server/routes/saved-steps.ts server/routes/saved-steps.test.ts server/saved-steps/saved-steps.ts server/index.ts
git commit -m "feat(saved-steps): forget a bot's saved steps over HTTP" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Chips under replies and the Settings switch

**Files:**
- Create: `src/components/SavedStepsChip.tsx`, `src/components/SavedStepsRow.tsx`
- Modify: `src/components/ChatView.tsx:75` and `:871` (same lines), `src/components/SettingsModal.tsx` (import, and `<SavedStepsRow />` after `<NewBotEffortRow />` at line 680), `src/state/store.tsx:136` (add `"savedSteps"` to the `Pick`), `src/state/config-status.ts:111` and `src/lib/feature-flags.ts:4` (`savedSteps?: boolean` inside `features`, same lines), `src/lib/feature-flags.ts` (new function), `src/locales/en.json` (after `chat.setupOffer.button`, and beside `settings.analytics.*`)
- Test: `src/components/SavedStepsChip.test.ts`, `src/components/SavedStepsRow.test.ts`, `src/lib/feature-flags.test.ts`

**Interfaces:**
- Consumes: `WireMessage.savedSteps` (Task 9); `DELETE /api/bots/:botId/saved-steps/:recipeId` (Task 10); `PATCH /api/config { features: { savedSteps } }` (Task 8).
- Produces: `SavedStepsChip({ botId, message }: { botId: string; message: Message })`, `SavedStepsRow()`, `savedStepsEnabled(config: FeatureFlagConfig | null | undefined): boolean` (`features?.savedSteps !== false`).
- Copy (`en.json`): `chat.savedSteps.learned` "Saved these steps · next time no AI"; `chat.savedSteps.replayed` "Repeated saved steps · no AI"; `chat.savedSteps.forget` "Forget"; `chat.savedSteps.forgotten` "Forgotten"; `chat.savedSteps.forgetFailed` "Could not forget these steps"; `settings.savedSteps.title` "Repeat computer tasks without AI"; `settings.savedSteps.subtitle` "When you ask a bot for a computer task it has done before, it repeats the saved steps instead of asking the AI. Off stops saving and repeating."; `settings.savedSteps.aria` "Repeat computer tasks without AI"; `settings.savedSteps.error` "Could not change this setting".

- [ ] **Step 1: Write the failing tests** (mocking pattern of `src/components/SetupOffer.test.ts`)

```ts
it("says the steps were saved", () => expect(render({ ...REPLY, savedSteps: { recipeId: "r1", learned: true } }).html).toContain("Saved these steps · next time no AI"));
it("says a reply came from saved steps", () => expect(render({ ...REPLY, savedSteps: { recipeId: "r1", replayed: true } }).html).toContain("Repeated saved steps · no AI"));
it("draws nothing on other replies", () => expect(render(REPLY).html).toBe(""));
it("Forget deletes the recipe and says so", async () => {
  view.forget!.props.onClick();
  expect(fixture.api).toHaveBeenCalledWith("/api/bots/b1/saved-steps/r1", { method: "DELETE" });
  await flush(); expect(render(LEARNED).html).toContain("Forgotten");
});
it("shows the failure and keeps Forget", async () => { /* api rejects -> role="alert" "Could not forget these steps"; button still present */ });
```
```ts
it("is on unless the config turns it off", () => { expect(savedStepsEnabled(null)).toBe(true); expect(savedStepsEnabled({ features: { savedSteps: false } })).toBe(false); });
it("the switch saves the opposite value", async () => {
  /* config without savedSteps -> Switch checked; click -> api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { savedSteps: false } }) }); dispatch({ type: "configStatus", config }) */
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run src/components/SavedStepsChip.test.ts src/components/SavedStepsRow.test.ts src/lib/feature-flags.test.ts`
Expected: FAIL, modules and function missing.

- [ ] **Step 3: Implement**

`SavedStepsChip`: a `ui-chip` row like `DigestChip` (`src/components/DigestChip.tsx:24-36`) with the label and a `Forget` text button (`data-saved-steps-forget`); a double click is ignored while the request is in flight (a `useRef` guard, as in `SetupOffer`); success shows `Forgotten` in place of the button. `SavedStepsRow`: `SettingRow` + `Switch` (`src/components/SettingsPrimitives.tsx`) bound to `savedStepsEnabled(state.config)`, saving like `MemorySection.toggleRooms` (`src/components/bot-settings/MemorySection.tsx:255-269`), error under the row.

`ChatView.tsx` must not grow: line 75 gains ` import { SavedStepsChip } from "./SavedStepsChip";` after the `SetupOffer` import, and line 871 gains `{m.savedSteps && <SavedStepsChip botId={botId} message={m} />}` after the `SetupOffer` element.

- [ ] **Step 4: Run them and see them pass**

Run: `pnpm exec vitest run src/components/SavedStepsChip.test.ts src/components/SavedStepsRow.test.ts src/lib/feature-flags.test.ts src/locales src/components/SettingsModal.simple.test.ts src/components/ChatView.rows.test.ts scripts/testing/file-size-ratchet.test.ts && pnpm i18n:check && pnpm typecheck && pnpm lint`
Expected: PASS; `ChatView.tsx` at 1348 and `store.tsx` at 3456 lines.

- [ ] **Step 5: Commit**

```bash
git add src/components/SavedStepsChip.tsx src/components/SavedStepsRow.tsx src/components/SavedStepsChip.test.ts src/components/SavedStepsRow.test.ts src/components/ChatView.tsx src/components/SettingsModal.tsx src/state/store.tsx src/state/config-status.ts src/lib/feature-flags.ts src/lib/feature-flags.test.ts src/locales/en.json
git commit -m "feat(saved-steps): reply chips with Forget, and the Settings switch" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Fake driver, docs and the verification run

**Files:**
- Create: `server/testing/fake-cua-driver.ts` (executable, `#!/usr/bin/env node`, imports only `node:` modules), `docs/verification/saved-steps.md`
- Modify: `docs/verification/README.md` (Drive list, after "Taking control of a bot's computer"), `docs/computer-use-integration.md:139-142` and `:179`
- Test: `server/testing/fake-cua-driver.test.ts`

**Interfaces:**
- Produces: a stdio MCP fake that answers `initialize`, `tools/list` (`list_apps`, `list_windows`, `get_window_state`, `click`, `type_text`) and `tools/call` with the fixture TextEdit shapes of Task 4. Env: `FAKE_CUA_STATE` (JSON file holding the snapshot counter, so separate processes agree), `FAKE_CUA_LOG` (one `{name, arguments}` JSON line per `tools/call`), `FAKE_CUA_FAIL` (while this path exists, `type_text` answers `isError` "Fixture failure."). Each `get_window_state` raises the counter; `click`/`type_text` with a token from an older snapshot answer `isError` "stale element token".

- [ ] **Step 1: Write the failing test**

```ts
it("hands out fresh tokens per snapshot and refuses stale ones", async () => {
  // spawn the fake (args ["mcp"]) with FAKE_CUA_STATE/LOG in a temp dir; rpc initialize, tools/list, then:
  expect((await call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s1-e2");
  expect((await call("get_window_state", { pid: 4242, window_id: 7 })).structuredContent.elements[2].element_token).toBe("s2-e2");
  expect((await call("click", { element_token: "s1-e2" })).isError).toBe(true);
  expect((await call("click", { element_token: "s2-e2" })).isError).toBeUndefined();
  expect(readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).name)).toEqual(["get_window_state", "get_window_state", "click", "click"]);
});
it("fails type_text while the fail file exists", async () => {});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run server/testing/fake-cua-driver.test.ts`
Expected: FAIL, file missing.

- [ ] **Step 3: Write the fake, then the docs**

`chmod +x server/testing/fake-cua-driver.ts` before adding it. Then run `pnpm exec vitest run server/testing/fake-cua-driver.test.ts server/testing/fakes-self-contained.test.ts` → PASS.

`docs/computer-use-integration.md`: line 179 becomes `5. Later: extension bridge, playwright-mcp tier. (Macro record/replay shipped as [saved steps](superpowers/specs/2026-10-27-saved-steps-design.md).)`; after the policy paragraph (line 142) add one sentence: saved steps replays the driver's own recorded tool calls through the same gated bridge, so it adds no input route, binary or permission identity beside cua-driver.

`docs/verification/saved-steps.md`, with sections "What it proves", "Run", "Evidence" and "Limits":
- Unit and route checks: `pnpm exec vitest run server/saved-steps server/routes/saved-steps.test.ts server/routes/computer-journal.test.ts server/local-computer-proxy.test.ts src/components/SavedStepsChip.test.ts src/components/SavedStepsRow.test.ts`.
- Fixture (macOS or Windows; on Linux the server never mounts this computer on its own):
  ```sh
  SCRATCH=$(mktemp -d)
  cat > "$SCRATCH/calls.json" <<'EOF'
  [{"server":"computer","name":"list_apps"},
   {"server":"computer","name":"list_windows","input":{"pid":4242}},
   {"server":"computer","name":"get_window_state","input":{"pid":4242,"window_id":7}},
   {"server":"computer","name":"click","input":{"element_token":"s1-e2"}},
   {"server":"computer","name":"type_text","input":{"element_token":"s1-e2","text":"hello world"}}]
  EOF
  FAKE_CLAUDE_TOOL_CALLS_FILE="$SCRATCH/calls.json" FAKE_CLAUDE_PROMPTS="$SCRATCH/prompts.jsonl" \
  FAKE_CLAUDE_REPLY_STATE="$SCRATCH/replies" \
  FAKE_CLAUDE_REPLIES='["Typed hello world into TextEdit. Nothing else changed.","Typed hello world into TextEdit again.","Typed it once more.","Typed it with the switch off."]' \
    node --experimental-strip-types scripts/control-omb.ts launch
  ```
  In a second terminal, with the printed `DATA` and `PORT`: write `$DATA/Library/Application Support/OpenMausBot/cua-connection.json` under `umask 077` as `{"mode":"embedded","status":"ready","socketPath":"$DATA/cua.sock","mcpCommand":"$PWD/server/testing/fake-cua-driver.ts","mcpArgs":["mcp"],"mcpEnv":{"FAKE_CUA_STATE":"$SCRATCH/cua-state.json","FAKE_CUA_LOG":"$SCRATCH/cua-calls.jsonl","FAKE_CUA_FAIL":"$SCRATCH/fail"}}`; `pnpm control:omb new-bot --name Typist --url http://127.0.0.1:$PORT` (BOT_ID; a new bot runs at Full access); `pnpm control:omb messages --bot BOT_ID --url …` gives `taskId` as THREAD_ID.
- Rounds, each `send` followed by `wait` (`settled`), then `curl -s "http://127.0.0.1:$PORT/api/threads/$THREAD_ID/messages?limit=40"`:
  1. Learn: `send --text "Open TextEdit and type hello world"` → last bot text has `savedSteps.learned: true` (keep its `recipeId`); `prompts.jsonl` has 1 line; `$DATA/bots/BOT_ID/saved-steps.json` holds one recipe and `stat -f %Lp` prints `600`.
  2. Replay: `send --text "Please open TextEdit and type hello world."` → `prompts.jsonl` still 1 line; `cua-calls.jsonl` gains `list_apps`, `list_windows`, `get_window_state`, `click {"element_token":"s2-e2"}`, then the same three lookups and `type_text {"text":"hello world", …"element_token":"s3-e2"}`; the reply is "Typed hello world into TextEdit." with `savedSteps.replayed: true`.
  3. Forget: `curl -s -X DELETE http://127.0.0.1:$PORT/api/bots/BOT_ID/saved-steps/RECIPE_ID` → `{"forgotten":true}`; the file's `recipes` is `[]`.
  4. Learn again: `rm "$SCRATCH/cua-state.json"`, send round 1's words → `prompts.jsonl` 2 lines, `learned: true` again.
  5. Fallback: `touch "$SCRATCH/fail"`, send round 1's words → `prompts.jsonl` 3 lines, the last containing "A saved run of this request did steps 1–1 of 2 and failed at step 2 (type_text on"; `recipes` is `[]`.
  6. Switch off: `rm "$SCRATCH/fail" "$SCRATCH/cua-state.json"`; `curl -s -X PATCH http://127.0.0.1:$PORT/api/config -H 'content-type: application/json' -d '{"features":{"savedSteps":false}}'`; send round 1's words → `prompts.jsonl` 4 lines, no `savedSteps` on the reply, `recipes` still `[]`.
- Evidence: keep each `wait` and `curl` JSON, `prompts.jsonl`, `cua-calls.jsonl` and the server log path under `.omb-scratch/verify-evidence/saved-steps/`.
- Limits: the driver and engine are fakes; this proves the harness path (journal, save, resolve, approvals, fallback, Stop wiring), not real macOS accessibility trees or a real model. The chips and the switch are proven by their component tests, not by this fixture.

README: add `- [Saved steps: repeating a computer task without AI](saved-steps.md)` after `- [Taking control of a bot's computer](take-control.md)`.

- [ ] **Step 4: Run the recipe**

Run every command in `docs/verification/saved-steps.md` against a fresh fixture, then interrupt `launch` with Ctrl-C.
Expected: each round shows exactly the counts and fields the recipe states. Fix the code, not the recipe, when a round disagrees.

- [ ] **Step 5: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm i18n:check && pnpm exec vitest run server/saved-steps server/routes scripts/testing src/components/SavedStepsChip.test.ts src/components/SavedStepsRow.test.ts`
Expected: PASS.

```bash
git add server/testing/fake-cua-driver.ts server/testing/fake-cua-driver.test.ts docs/verification/saved-steps.md docs/verification/README.md docs/computer-use-integration.md
git commit -m "test(saved-steps): fake driver fixture and verification recipe" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review

- Spec coverage: recording §1 → Tasks 2-3; saving rules, identity targets, store, key, reply patch §2 → Tasks 1, 4, 5, 9; replay preconditions, resolution, approvals, stand-in engine, Stop, fallback note and turn-id remap §3 → Tasks 6-8; chips, Forget, setting §4 → Tasks 10-11 (server flag in Task 8); policy doc §5 → Task 12; spec tests → each task's tests plus the Task 12 fixture.
- Where the plan departs from the spec, deliberately: the journal also keeps `list_apps` `apps[]` and `list_windows` `windows[]` (the only sources of `bundle_id` and window titles by id); a gate-check count makes a lost entry visible; typed text is re-checked against the new words before a replay; the Full-access answer is routed to the running engine (`server/index.ts:6699-6701` sent it to the registry's instance, which would never reach the stand-in); a step 1 failure gets its own note wording; a fallback whose failed step was a tool error does not re-save (the error stays in that request's journal), and the next AI run of those words saves.
- Types: `JournalEntry`, `RequestJournal`, `Recipe`, `RecipeStep`, `ComputerCaller`, `CallOutcome`, `ReplayOutcome`, `ReplayRequest` and `SavedStepsDeps` are each defined once and used by the names above.
