# My Chrome on My Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a bot on My Cloud whose browser profile is My Chrome drives the person's real Chrome on their lent Mac or PC whenever that computer is online.

**Architecture:** the device link that lends the internet connection gets a second kind of stream, `{chrome: true}`. The lent computer answers it by connecting to its own Chrome's DevTools port and rewriting only the WebSocket upgrade. On My Cloud, a per-session loopback "door" hands agent-browser a `ws://` address. Each connection through the door is checked with the existing `mayLend` rule, and the door routes it through that link.

**Tech Stack:** Node 22/24, TypeScript server (vitest), Electron main in `.mjs` (`node --test`), React + Tailwind renderer, `ws`.

**Spec:** `docs/superpowers/specs/2026-10-26-cloud-my-chrome-design.md`

## Global Constraints

- `server/index.ts` is pinned at **16238** lines by `scripts/testing/file-size-ratchet.test.ts` and may only shrink. Do every bit of wiring there on existing lines: lengthen a line, never add one.
- Personal Cloud home only: the server uses a lent Chrome only when `CLOUD_PERSONAL`, and advertises `myChromeLink` only when `cloudTeam !== true`.
- Chrome is never lent by default. `defaultGrant` keeps `chrome` only when the previous grant had `chrome === true`.
- The Cloud never names a host or port for a Chrome stream. The lent computer connects only to `127.0.0.1:<port from its own DevToolsActivePort>`.
- No fallback: a My Chrome session on My Cloud never silently uses the built-in browser.
- New UI copy goes in `src/locales/en.json` only (other locales fall back to English).
- Match the surrounding code: short comments that say why, no new abstractions beyond the ones named here.
- Commit after each task. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push and never open a PR.
- Known local failures on this Mac (Node 22, sandboxed network), not caused by this work: in `server/device-links.test.ts`, "opens only for the session and secret that registered the computer…" times out. In `electron/device-link.node-test.mjs`, subtests 7–11 are cancelled. Don't chase them; CI on Node 24 is the reference.

## Review Focus

1. **A conversation someone else wrote in reuses a browser whose Chrome connection an owner turn opened.** Expect the connection to be dropped when that turn claims the browser, and its tool calls refused. Test in Task 6.
2. **The Mac sleeps or quits mid-turn.** Expect the next tool call to explain "offline" in one line instead of a raw CDP error. Tests in Task 5 (`gone` → `offline`) and Task 6 (`afterCall`).
3. **Chrome is closed but its `DevToolsActivePort` file is left over.** Expect "Chrome isn't open with remote debugging on", not "unreachable". Test in Task 2 (ECONNREFUSED → `no-chrome`).
4. **A request through the Chrome stream that isn't a WebSocket upgrade** (for example `GET /json/new?https://…`), or an oversized head. Expect `403` or a destroyed stream; nothing reaches Chrome. Test in Task 2.
5. **Another local process connects to the Cloud door without the token.** Expect `404`, with no stream opened and no problem recorded for the session. Test in Task 5.

---

### Task 1: The link carries a Chrome stream, and the computer checks its own grant

**Files:**
- Modify: `electron/device-link-protocol.mjs` (header comment; `open`; `onControl` case `"open"`), `electron/device-link-protocol.d.mts`
- Modify: `electron/device-link.mjs` (`runDeviceLink` options and `accept`), `electron/device-link.d.mts`
- Test: `electron/device-link.node-test.mjs`

**Interfaces:**
- Produces: `mux.open(target: { host: string; port: number } | { chrome: true }): Promise<LinkOpened>`. The control frame is `{ t: "open", id, chrome: true }` for Chrome, unchanged otherwise. `accept(target)` receives exactly `{ chrome: true }` when `message.chrome === true`, else `{ host: message.host, port: message.port }`.
- Produces: `runDeviceLink({ …, lends = () => ({ internet: true, chrome: false }), chrome = {} })`. `chrome` is passed to `createChromeDoor` from Task 2 (tests inject `dirs`, `readFile`, `connect`). `accept` answers `{ refused: "not-lent" }` for a Chrome stream when `!lends().chrome`, and for a host/port stream when `!lends().internet`. Otherwise it answers `chromeDoor.open()` or `deviceEgress.open(target)`. `onStream(target, result)` is called for both.
- Note: Task 2 creates `createChromeDoor`. Do Task 2 first if you prefer; this task's tests inject a fake door through `chrome.open` (see Step 1), so the order doesn't matter.

- [ ] **Step 1: Write the failing tests** in `electron/device-link.node-test.mjs`:
  - `"a Chrome stream reaches the computer as { chrome: true } and never carries a host or port"`: two muxes wired back to back, the computer side's `accept` records its target. Cloud side `open({ chrome: true })`. Assert the recorded target `deepEqual({ chrome: true })`. Assert the first control frame sent is `{ t: "open", id: 1, chrome: true }`.
  - `"the computer opens a Chrome stream only while it lends Chrome, and a web stream only while it lends its internet connection"`: `runDeviceLink` against a local `WebSocketServer` playing My Cloud, with `lends: () => ({ internet: false, chrome: false })`. Assert `{ t: "refused", reason: "not-lent" }` for both `{ chrome: true }` and `{ host: "example.com", port: 443 }`. Then with `lends` returning `chrome: true`, and `chrome: { open: async () => ({ socket }) }` where `socket` is one end of a `net` socket pair to a local echo server, assert `{ t: "opened" }` and bytes echo back.

- [ ] **Step 2: Run them, expect FAIL**: `node --test --test-name-pattern="Chrome stream|lends Chrome" electron/device-link.node-test.mjs`

- [ ] **Step 3: Implement** the protocol change and the `runDeviceLink` `lends` / `chrome` options. When `chrome.open` is given, use it as the door (the test seam); otherwise `createChromeDoor(chrome)`. Update both `.d.mts` files and the protocol header comment (one line: `open {id, host, port} or {id, chrome: true}`).

- [ ] **Step 4: Run** `node --test electron/device-link.node-test.mjs`. Expect the new tests to PASS and subtests 1–6 to still PASS (7–11 are the known local cancellations).

- [ ] **Step 5: Commit** `feat(lending): the device link carries a Chrome stream, and the computer checks its own grant`

### Task 2: The lent computer's Chrome door

**Files:**
- Create: `electron/device-chrome.mjs`, `electron/device-chrome.d.mts`
- Test: `electron/device-chrome.node-test.mjs`

**Interfaces:**
- Produces:
  - `DEVTOOLS_FILE = "DevToolsActivePort"`
  - `MAX_HEAD = 16 * 1024`
  - `chromeDataDirs({ platform, home, localAppData }): string[]`, in this order:
    - darwin: `<home>/Library/Application Support/{Google/Chrome, Google/Chrome Canary, BraveSoftware/Brave-Browser}`
    - win32: `<localAppData>/{Google/Chrome/User Data, Google/Chrome SxS/User Data, BraveSoftware/Brave-Browser/User Data}`
    - linux: `<home>/.config/{google-chrome, google-chrome-unstable, BraveSoftware/Brave-Browser}`
  - `parseDevtoolsActivePort(text: string): { port: number; path: string } | null`. Line 1 is an integer 1–65535. Line 2 matches `^/devtools/browser/[A-Za-z0-9-]+$`.
  - `rewriteHandshake(head: string, target: { port: number; path: string }): string | null`. `head` is the request line plus headers, without the final blank line. Accept only `GET <p> HTTP/1.1` with an `Upgrade: websocket` header (case-insensitive name and value). If `<p>` starts with `/devtools/browser` (optionally followed by `/…` or `?…`), replace it with `target.path`. If `<p>` matches `^/devtools/page/[A-Za-z0-9-]+$`, keep it. Refuse anything else. Replace `Host` with `127.0.0.1:<port>` and remove every `Origin` header. Return the new head ending in `\r\n\r\n`, or `null` to refuse.
  - `createChromeDoor({ dirs?, readFile?, connect?, connectMs = 10_000 } = {}): { open(): Promise<{ socket: import("node:stream").Duplex } | { failed: "no-chrome" | "timeout" | "unreachable" }> }`
    - `open()` reads the first dir whose `DevToolsActivePort` parses. With none, it answers `{ failed: "no-chrome" }`.
    - It connects to `{ host: "127.0.0.1", port }` only. `ECONNREFUSED` → `{ failed: "no-chrome" }` (Chrome was closed and the file is left over). Timeout → `{ failed: "timeout" }`. Any other error → `{ failed: "unreachable" }`.
    - On connect it answers `{ socket: guard }`. `guard` is a `Duplex`: bytes written to it are buffered until `\r\n\r\n`. If they pass `rewriteHandshake`, the rewritten head plus the bytes after it go to Chrome, and every later byte passes through both ways. If they don't, the guard pushes `HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`, ends, and destroys the Chrome socket. A head over `MAX_HEAD` without `\r\n\r\n` destroys both. `pause`/`resume`, `end` and `destroy` map onto the Chrome socket.
    - Default `dirs` come from `chromeDataDirs({ platform: process.platform, home: os.homedir(), localAppData: process.env.LOCALAPPDATA })`.

- [ ] **Step 1: Write the failing tests** in `electron/device-chrome.node-test.mjs`. "Fake Chrome" means an `http` server plus a `WebSocketServer({ noServer: true })` that upgrades only `/devtools/browser/REAL-ID` and records each upgrade request's `url`, `host` and `origin`.
  - `"reads DevToolsActivePort: a port and Chrome's browser path, nothing else"`: `parseDevtoolsActivePort("9222\n/devtools/browser/abc-1\n")` deepEquals `{ port: 9222, path: "/devtools/browser/abc-1" }`. Each of `""`, `"0\n/devtools/browser/x"`, `"70000\n/devtools/browser/x"`, `"9222\n/json/new"` and `"9222\n/devtools/browser/../x"` gives `null`.
  - `"looks only in Chrome's own folders, in agent-browser's order"`: `chromeDataDirs({ platform: "darwin", home: "/U" })` deepEquals the three darwin paths. win32 and linux likewise.
  - `"rewrites only a WebSocket upgrade to Chrome's browser or a page, with Chrome's own host and no Origin"`: a head with `GET /devtools/browser/TOKEN HTTP/1.1`, `Host: 127.0.0.1:5555`, `Origin: https://evil.test`, `Upgrade: websocket` and `Connection: Upgrade` becomes a head with `GET /devtools/browser/REAL-ID HTTP/1.1`, `Host: 127.0.0.1:9222` and no `Origin`. `/devtools/page/AB12` is kept. `GET /json/new?https://x HTTP/1.1` (with upgrade), `POST /devtools/browser/x HTTP/1.1`, and a `GET /devtools/browser/x` without `Upgrade` each give `null`.
  - `"a door to a running Chrome upgrades end to end and passes frames unchanged"`: a fake Chrome on an ephemeral port, a temp dir holding `DevToolsActivePort` (`<port>\n/devtools/browser/REAL-ID`), and `createChromeDoor({ dirs: [tmp] })`. `open()` gives `{ socket }`. Pipe it to a local TCP server, and have a `ws` client connect there to `ws://127.0.0.1:<that>/devtools/browser/TOKEN`. Send `{"id":1,"method":"Browser.getVersion"}` and get the fake's echo back. Assert the fake saw url `/devtools/browser/REAL-ID`, host `127.0.0.1:<fake port>` and origin `undefined`.
  - `"a request that is not a WebSocket upgrade gets 403 and never reaches Chrome"`: write `GET /json/new?https://x HTTP/1.1\r\nHost: a\r\n\r\n` to the guard. Read `HTTP/1.1 403 Forbidden`. The fake saw no request.
  - `"an oversized head is dropped"`: write `MAX_HEAD + 1` bytes with no blank line. The guard is destroyed and the fake saw no request.
  - `"no DevToolsActivePort, or a stale one whose port refuses, is no-chrome"`: an empty dir → `{ failed: "no-chrome" }`. A file pointing at a closed port → `{ failed: "no-chrome" }`.

- [ ] **Step 2: Run, expect FAIL**: `node --test electron/device-chrome.node-test.mjs` (module not found)

- [ ] **Step 3: Implement** `electron/device-chrome.mjs` and its `.d.mts`. The header comment names what the door is: the lent computer's own way to its Chrome. It finds the port itself and lets through only the upgrade.

- [ ] **Step 4: Run** `node --test electron/device-chrome.node-test.mjs electron/device-link.node-test.mjs` and expect PASS (except the known cancellations).

- [ ] **Step 5: Commit** `feat(lending): the lent computer's door to its own Chrome`

### Task 3: The desktop lends Chrome when the person turns it on

**Files:**
- Modify: `electron/computer-sharing.mjs` (`describe`/`cloudIdentity`, `saveCloud`, the connect body, the `keepLink` condition and its `runDeviceLink` call, `browsed`, `cloudState`), `electron/computer-sharing.d.mts`
- Modify: `electron/cloud-lending-ipc.mjs` (`pageLending`, `defaultGrant`, `choice` and the three `save(env(), await choice({...}))` sites), `electron/cloud-lending-ipc.d.mts`
- Test: `electron/cloud-lending.node-test.mjs`, `electron/cloud-lending-ipc.node-test.mjs`

**Interfaces:**
- Consumes: Task 1's `runDeviceLink({ lends, chrome })`.
- Produces:
  - Grant field `chrome: boolean`.
  - `createComputerSharing({ …, chrome = {} })` forwards `chrome` to `runDeviceLink`, next to `egress` (the test seam Task 8 uses).
  - `saveCloud(env, { …, chrome?: boolean })`. "Choose at least one…" counts `chrome === true`, and its message becomes "Choose at least one folder, apps and screen, the internet connection, your Chrome, or the terminal."
  - `supportsChrome: Set<envId>`, set from `descriptor.capabilities?.myChromeLink === true`.
  - Connect body adds `...(grant.cloud && supportsChrome.has(env.id) ? { chrome: grant.chrome === true } : {})`.
  - The link is kept when `grant.cloud && supportsLink.has(env.id) && (grant.internet === true || (grant.chrome === true && supportsChrome.has(env.id)))`.
  - `lends: () => ({ internet: grant.internet === true, chrome: grant.chrome === true && supportsChrome.has(env.id) })`.
  - `cloudState(env)` adds `chrome: boolean` and, while lent and connected with `chrome`, `chromeLink: "on" | "connecting" | "unsupported"` (same rule as `internetState`, using `supportsChrome`).
  - Activity: each Chrome stream is recorded once per `BROWSE_NOTE_MS` as `{ action: "chrome", detail: "", ok, error? }`.
  - `pageLending` adds `chrome: on && state.chrome === true`. `defaultGrant` adds `chrome: kept?.chrome === true`. `choice()` passes `chrome: input?.chrome === true` and treats Chrome alone as a choice.

- [ ] **Step 1: Write the failing tests:**
  - `cloud-lending.node-test.mjs` → `"lends Chrome only when the person turns it on, and tells only a Cloud that takes it"`. Use the existing fake-Cloud harness. If the descriptor has no `myChromeLink`, saving `{ chrome: true, folders: [] }` registers with no `chrome` key. With `myChromeLink: true`, it registers `chrome: true`, the device link is dialled, and `cloudState(env).chrome === true`. Saving `{ folders: [usual], screen: false }` registers `chrome: false`.
  - `cloud-lending.node-test.mjs` → `"a Chrome-only grant keeps the device link open, and the link refuses web streams"`: with grant `{ chrome: true, internet: false }`, the fake Cloud's link receives `{ t: "refused", reason: "not-lent" }` for an `{ host, port }` open.
  - `cloud-lending-ipc.node-test.mjs` → `"the default grant never lends Chrome unless it was lent before"`: `defaultGrant({ kept: null, … }).chrome === false`, and `defaultGrant({ kept: { chrome: true, folders: [] }, … }).chrome === true`. Also `pageLending({ state: { enabled: true, chrome: true } }).chrome === true`.

- [ ] **Step 2: Run, expect FAIL**: `node --test electron/cloud-lending.node-test.mjs electron/cloud-lending-ipc.node-test.mjs`

- [ ] **Step 3: Implement** the interfaces above, keeping each change next to its `internet` twin.

- [ ] **Step 4: Run** `pnpm test:electron` and expect PASS (except the known cancellations).

- [ ] **Step 5: Commit** `feat(lending): the desktop lends its Chrome to My Cloud when the person turns it on`

### Task 4: My Cloud knows which computer lends Chrome

**Files:**
- Modify: `server/environment.ts` (`myChromeLink` capability, `cloudTeam` input), and `server/index.ts` lines 13060 and 13130 (pass `cloudTeam: CLOUD_TEAM !== null` on the same lines)
- Modify: `server/lent-computers.ts` (record and `connected` input `chrome?: boolean`)
- Modify: `server/shared-computers.ts` (registration `chrome`, `remember`, scopes in `KnownLentComputer`/`SharedComputerStatus`, `linkable`, new `chromeLender`)
- Modify: `server/device-links.ts` (`LinkedComputer.chrome`, new `chromeRoute`)
- Test: `server/environment.test.ts`, `server/lent-computers.test.ts`, `server/shared-computers.test.ts`, `server/device-links.test.ts`

**Interfaces:**
- Consumes: Task 1's `mux.open({ chrome: true })`.
- Produces:
  - `EnvironmentDescriptor.capabilities.myChromeLink?: true`, present when `sharedComputers === true && cloudHome === true && cloudTeam !== true`.
  - `sharedComputerRegistration.chrome: z.boolean().optional()`, with the comment "sent only to a server that advertises myChromeLink".
  - `scopes.chrome: boolean` in both status types.
  - `LentComputer.chrome?: boolean`.
  - `SharedComputers.chromeLender(principal: string): { name: string; device: "PC" | "Mac" | "computer"; online: boolean } | null`. This is the newest record (`lent.list` order) with `chrome === true && stoppedAt === null`, and `online` means its id is in `list(principal)`.
  - `export interface ChromeRoute { open(): Promise<LinkOpened> }`
  - `DeviceLinks.chromeRoute(person: string): ChromeRoute | null`. This is the newest open, live link of `person` with `computer.chrome`. `open()` calls `mux.open({ chrome: true })` and marks the computer used the same way `route` does.

- [ ] **Step 1: Write the failing tests:**
  - `environment.test.ts` → `"advertises myChromeLink only on a personal Cloud home with lending"`. Assert `myChromeLink === true` for `{ sharedComputers: true, cloudHome: true }`. Assert it is absent for `cloudTeam: true`, for `cloudHome: false`, and for `sharedComputers: false`.
  - `lent-computers.test.ts` → `"remembers whether a computer lends its Chrome"`. After `connected(person, { …, chrome: true })` and a reload from disk, `list(person)[0].chrome === true`.
  - `shared-computers.test.ts` → `"chromeLender names the newest computer that lends Chrome, and whether it is online"`. Register A (`chrome: true`) and then B (`chrome: false`). Assert `chromeLender(p)` deepEquals `{ name: "A", device: "Mac", online: true }`. After A's session dies, `online` is `false`. After A's lending stops, the result is `null`.
  - `device-links.test.ts` → `"a Chrome stream goes only to a computer that lends Chrome, through its own door"`. Use the existing in-process harness. Run the computer's `runDeviceLink` with `lends: () => ({ internet: false, chrome: true })` and `chrome: { open: async () => ({ socket }) }`, where `socket` goes to a local echo server. `chromeRoute(PERSON)` is non-null, and `open()` gives `{ join }` with bytes echoed. Also: a computer registered without `chrome` gives `chromeRoute(PERSON) === null`, while `route(PERSON)` still works when it lends its internet connection.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run server/environment.test.ts server/lent-computers.test.ts server/shared-computers.test.ts server/device-links.test.ts`

- [ ] **Step 3: Implement** the interfaces. In `index.ts`, change only lines 13060 and 13130. Confirm with `wc -l server/index.ts` that it is still 16238.

- [ ] **Step 4: Run** the same command plus `npx vitest run scripts/testing/file-size-ratchet.test.ts`, and expect PASS (except the known device-links timeout).

- [ ] **Step 5: Commit** `feat(cloud): My Cloud knows which lent computer lends its Chrome`

### Task 5: My Cloud's door for a session's Chrome

**Files:**
- Create: `server/browser/lent-chrome.ts`
- Test: `server/browser/lent-chrome.test.ts`

**Interfaces:**
- Consumes: Task 4's `ChromeRoute`, and `LinkOpened` from `electron/device-link-protocol.mjs`.
- Produces:

```ts
export type LentChromeProblem = "offline" | "not-lent" | "no-chrome" | "unreachable" | "not-allowed";
export type ChromeLender = { name: string; device: "PC" | "Mac" | "computer"; online: boolean };
export interface LentChromeDeps {
  route(): ChromeRoute | null;
  /** Whether the session's last holder may use the lent computer (lentDevice's rule). */
  allowed(session: string): boolean;
  idleMs(): number;
  /** For tests; real timers otherwise. */
  sweepMs?: number;
}
export class LentChromeDoors {
  constructor(deps: LentChromeDeps);
  /** The address agent-browser connects to for this session: ws://127.0.0.1:<port>/devtools/browser/<64 hex token>. One per session, reused. */
  door(session: string): Promise<string>;
  owns(session: string): boolean;
  /** Ends every open connection of that session; the next one is checked afresh. */
  drop(session: string): void;
  /** Why the session's last connection could not reach Chrome; cleared once one does. */
  problem(session: string): LentChromeProblem | null;
  close(): void;
}
export function lentChromeGuidance(problem: LentChromeProblem, lender: ChromeLender | null): string;
```

- Per-connection rules, in order:
  1. Read the request head (at most 16 KiB, at most 10 s), else destroy.
  2. If the path is not exactly `/devtools/browser/<token>` (`timingSafeEqual`), answer `404` and record no problem.
  3. If `!allowed(session)`, answer `403` and record `not-allowed`.
  4. If `route()` is null, answer `503` and record `offline`.
  5. Call `route.open()`:
     - `{ join }` → `join(socket, Buffer.concat([head, rest]))`, and clear the problem.
     - `{ refused: "not-lent" }` → `not-lent`. Any other `refused` → `unreachable`.
     - `{ failed: "no-chrome" }` → `no-chrome`. Any other `failed` → `unreachable`.
     - `{ gone }` → `offline`.
     - Every non-join outcome answers `502`.
- Idle: a joined connection with no bytes from agent-browser for `idleMs()` is destroyed. The sweep runs every `sweepMs ?? 30_000`, and its timers are `unref`'d.
- Guidance copy (bot-facing; `name` and `device` come from the lender, with "your computer" when there is none):
  - `offline`: `${name} is lent but offline: OpenMausBot on it is closed or the ${device} is asleep. Tell the person in one sentence to open OpenMausBot on that ${device}. Do not switch to another browser.`
  - `not-lent`: `No computer lends its Chrome to My Cloud now. Tell the person in one sentence to turn on Your Chrome under Settings → MausBot Cloud in OpenMausBot on their Mac or PC.`
  - `no-chrome`: `Chrome on ${name} isn't open with remote debugging on. Tell the person in one sentence to open Chrome on that ${device}, turn on remote debugging at chrome://inspect/#remote-debugging, and allow the connection when Chrome asks.`
  - `unreachable`: `Chrome on ${name} did not accept the connection; it may be waiting for the person to click Allow. Tell them in one sentence to check Chrome on that ${device}.`
  - `not-allowed`: `Someone else wrote in this conversation, so it can't use your Chrome. Start a new conversation to use it.`

- [ ] **Step 1: Write the failing tests** in `server/browser/lent-chrome.test.ts`. The fake route's `open()` returns a scripted `LinkOpened`. `join(socket, early)` pipes to a local echo server after writing `early`. The client is a raw `net` socket that writes a WebSocket upgrade head.
  - `"hands out one tokenized loopback address per session"`: two `door("s1")` calls give the same URL, matching `^ws://127\.0\.0\.1:\d+/devtools/browser/[a-f0-9]{64}$`. `door("s2")` gives a different port and token. `owns("s1")` is true and `owns("x")` is false.
  - `"a connection without the token gets 404, opens no stream and records nothing"`: wrong token → `HTTP/1.1 404`. The route's `open` is never called, and `problem("s1") === null`.
  - `"joins the session's connection through the route, head included"`: the echo receives the exact head bytes, and later bytes round-trip.
  - `"a refused holder gets 403 and not-allowed"`: `allowed: () => false` → `403` and `problem === "not-allowed"`, with `open` never called.
  - `"each way of not reaching Chrome is recorded"`: a table of route outcomes → problem: `null` route → `offline`, `{ gone: true }` → `offline`, `{ refused: "not-lent" }` → `not-lent`, `{ refused: "port" }` → `unreachable`, `{ failed: "no-chrome" }` → `no-chrome`, `{ failed: "timeout" }` → `unreachable`. Each answer starts `HTTP/1.1 50`. A later joined connection clears the problem.
  - `"drop ends the session's open connections and nothing else's"`: with s1 and s2 joined, after `drop("s1")` s1's client sees close and s2 still echoes.
  - `"a connection unused for the idle time is closed"`: with `idleMs: () => 50` and `sweepMs: 10`, the client sees close within 1 s.
  - `"guidance names the computer and what to do"`: `lentChromeGuidance("offline", { name: "Omkar's MacBook", device: "Mac", online: false })` contains `Omkar's MacBook` and `open OpenMausBot on that Mac`. `lentChromeGuidance("no-chrome", null)` contains `chrome://inspect/#remote-debugging`.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run server/browser/lent-chrome.test.ts`

- [ ] **Step 3: Implement** `server/browser/lent-chrome.ts` (`node:net` server per session on `127.0.0.1:0`, `randomBytes(32)` token).

- [ ] **Step 4: Run** `npx vitest run server/browser/lent-chrome.test.ts` and expect PASS.

- [ ] **Step 5: Commit** `feat(cloud): a per-session door from the bots' browser to the person's lent Chrome`

### Task 6: The browser host uses the lent Chrome for My Chrome profiles

**Files:**
- Modify: `server/turn-resources.ts` (`onClaim`)
- Modify: `server/browser/engines.ts` (`RuntimeRouterOptions.refusal` gains `session`, new `afterCall`)
- Modify: `server/host/browser.ts` (deps, `myChromeAvailable`, `browserSessionSpec` `cdpUrl` argument, `browserIntegration`/`currentBrowserSpec`, refusal/afterCall wiring, claim hook, `lentChromeSummary`, `closeAll`)
- Modify: `server/index.ts`, existing lines only: the `createBrowserHost({...})` call at 2529, the destructuring list at 2527, and `progress` in `browserEngineSummary` at 2568
- Test: `server/turn-resources.test.ts`, `server/browser/engines.test.ts`, `server/host/browser.test.ts`

**Interfaces:**
- Consumes: Task 4's `chromeRoute` and `chromeLender`, and Task 5's `LentChromeDoors` and `lentChromeGuidance`.
- Produces:
  - `TurnResources.onClaim(listener: (resource: string, owner: TurnOwner) => void): () => void`. It fires only when a claim makes `owner` the new holder (after `owners.set`), never when an owner re-claims what it already holds. `BrowserHostDeps.turnResources` becomes `Pick<TurnResources, "free" | "holder" | "onClaim">`.
  - `RuntimeRouterOptions.refusal?(session: string, spec, params): string | null` and `afterCall?(session: string, spec, result: unknown): unknown`. `afterCall` runs after `annotate`, on `tools/call` only.
  - `BrowserHostDeps.lentChrome?: { route(): ChromeRoute | null; lender(): ChromeLender | null }`
  - Host internals:
    - `lentChromeAllowed(session)` remembers each holder's `mayLend` verdict like `lentDevice`, defaulting to allowed when no turn has held the session.
    - `lentChromeSession(profileId)` is `!DESKTOP_MANAGED && browserEngineAttachCdpUrl(cfg) === null && doors !== undefined && usesMyChrome(profileId)`.
  - `myChromeAvailable()` is `DESKTOP_MANAGED || browserEngineAttachCdpUrl(cfg) !== null || Boolean(deps.lentChrome?.lender())`.
  - `browserSessionSpec(binaryPath, session, profile, egressPort?, cdpUrl?)`: when `usesMyChrome(profile)`, `attach` is `{ cdpUrl: cdpUrl ?? attachCdpUrl }` if either is set, else `{}`. `browserIntegration` and `currentBrowserSpec` pass `await doors.door(session)` when `lentChromeSession(browserProfileId)`.
  - Refusal for a session `doors.owns`, in order:
    1. `!lentChromeAllowed(session)` → `lentChromeGuidance("not-allowed", lender)`.
    2. No lender → `"not-lent"` guidance.
    3. `!lender.online` → `"offline"` guidance.
    4. Otherwise null, and the existing egress refusal rule still applies to other sessions.
  - `afterCall`: for an owned session whose result `isError` and whose `doors.problem(session)` is set, append one text part with the guidance.
  - On claim: a resource `browser:<session>` where `doors.owns(session)` and `!mayLend(owner)` → record the verdict, then `doors.drop(session)`.
  - `lentChromeSummary(): { myChromeOn?: ChromeLender; myChromeLendable?: true }`. With a lender → `{ myChromeOn }`. With `deps.lentChrome` but no lender → `{ myChromeLendable: true }`. Otherwise `{}`.
  - `index.ts` passes `lentChrome: CLOUD_PERSONAL ? { route: () => deviceLinks.chromeRoute(CLOUD_HOME_LENDER), lender: () => sharedComputers.chromeLender(CLOUD_HOME_LENDER) } : undefined` and spreads `...lentChromeSummary()` into `progress`.

- [ ] **Step 1: Write the failing tests:**
  - `turn-resources.test.ts` → `"onClaim fires when a turn becomes a resource's holder, not when it claims again"`.
  - `engines.test.ts` → `"refusal and afterCall see the session"`: a router with a stub old runtime records the session passed to `refusal`. `afterCall` receives the annotated result and its return value is what `agentRpc` returns.
  - `host/browser.test.ts` (use its existing host fixture, with `DESKTOP_MANAGED: false`, `CLOUD_HOME: {}`, a stub `lentChrome` and `mayLend`):
    - `"on My Cloud a My Chrome profile attaches through the lent computer's door"`: with config `browserProfiles: [{ id: "mine", name: "Mine", browser: "chrome" }]` and a lender `{ name: "Mac", device: "Mac", online: true }`, `myChromeAvailable() === true` and `browserIntegration(bot, "mine", turn)` gives `spec.env.AGENT_BROWSER_CDP` matching the door URL pattern, with no `AGENT_BROWSER_AUTO_CONNECT`. With lender `null`, `myChromeAvailable() === false`.
    - `"a conversation that may not lend loses the Chrome connection and is told why"`: `mayLend` returns false for turn B. When B claims `browser:<session>` through `turnResources.claim`, `doors.drop` is called (spy), and `browserRuntime.agentRpc(session, spec, "tools/call", …)` returns `isError` with text `Someone else wrote in this conversation, so it can't use your Chrome.`
    - `"an offline or missing lender is explained before the call reaches the browser"`: lender `online: false` → the refusal text contains `is lent but offline`. Lender `null` → the text contains `turn on Your Chrome`.
    - `"the summary says which computer lends Chrome, or that one can"`: `lentChromeSummary()` gives `{ myChromeOn: lender }` with a lender and `{ myChromeLendable: true }` without one. On the desktop host (no `lentChrome`) it gives `{}`.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run server/turn-resources.test.ts server/browser/engines.test.ts server/host/browser.test.ts`

- [ ] **Step 3: Implement.** In `index.ts`, edit only lines 2527, 2529 and 2568. `wc -l server/index.ts` must still print 16238.

- [ ] **Step 4: Run** the Step 2 command plus `npx vitest run scripts/testing/file-size-ratchet.test.ts server/cloud-lending-browser.e2e.test.ts server/browser-engine.test.ts`, and expect PASS.

- [ ] **Step 5: Commit** `feat(cloud): My Chrome profiles on My Cloud use the person's lent Chrome`

### Task 7: Settings say where My Chrome is, and the desktop has the switch

**Files:**
- Modify: `src/state/config-status.ts` (`BrowserEngineSummary.myChromeOn?`, `myChromeLendable?`)
- Modify: `src/components/BrowserProfilesManager.tsx` (the `chromeNote` lines and the unavailable paragraph)
- Modify: `src/components/CloudLending.tsx` (`lentWhat`, `choiceOf`, `lend`, the Chrome checkbox after the internet one, the unsupported note), `src/components/LendingActivity.tsx` (`chrome: "lending.action.chrome"`)
- Modify: `src/locales/en.json`
- Test: `src/components/BrowserProfilesManager.test.ts`, `src/components/CloudLending.test.ts`

**Interfaces:**
- Consumes: Task 6's summary fields and Task 3's `CloudLendingState.chrome` and `chromeLink`.
- Copy (en.json, exact):
  - `"settings.profiles.myChromeLent": "On My Cloud this is the Chrome on {name}, your {device}. It works while that {device} is awake with OpenMausBot open, in conversations you started yourself."`
  - `"settings.profiles.myChromeLentOffline": "{name} is offline right now."`
  - `"settings.profiles.myChromeLend": "To use My Chrome on My Cloud, lend it from your Mac or PC: open OpenMausBot there, go to Settings → MausBot Cloud, and turn on Your Chrome."`
  - `"lending.chrome": "Your Chrome"`
  - `"lending.chromeHelp": "Bots on My Cloud can use Chrome on this computer, signed in as you, in your own conversations and routines. That reaches every site you're signed in to. Turn on remote debugging at chrome://inspect/#remote-debugging first; Chrome asks you to allow the connection."`
  - `"lending.chromeUnsupported": "My Cloud is updating. Your bots can use your Chrome once it's done."`
  - `"lending.page.chrome": "your Chrome"`
  - `"lending.action.chrome": "Used your Chrome"`
- Rendering:
  - `BrowserProfilesManager`: wherever `chromeNote` shows and `myChromeOn` is set, render the `myChromeLent` line after the hint, then `myChromeLentOffline` when `online === false`. The unavailable paragraph uses `myChromeLend` when `myChromeLendable === true`, else the existing `myChromeUnavailable`.
  - `CloudLending`: `lentWhat(folders, screen, internet, terminal, chrome = false)` lists `lending.page.chrome` after the internet connection. The checkbox has `data-lending-chrome-choice`, and `chromeLink === "unsupported"` shows `lending.chromeUnsupported`.

- [ ] **Step 1: Write the failing tests:**
  - `BrowserProfilesManager.test.ts` → `"on My Cloud, My Chrome names the lent computer and says when it is offline"`: render with `browserEngine: { myChrome: true, myChromeOn: { name: "Studio Mac", device: "Mac", online: false } }` and a profile `browser: "chrome"`. The HTML contains `the Chrome on Studio Mac, your Mac` and `Studio Mac is offline right now.`, and the My Chrome `<option>` is not disabled.
  - `BrowserProfilesManager.test.ts` → `"on My Cloud with nothing lent, it says how to lend Chrome"`: `browserEngine: { myChrome: false, myChromeLendable: true }` → contains `turn on Your Chrome`, and does not contain `there is no Chrome of yours to use`.
  - `CloudLending.test.ts` → `"lentWhat lists your Chrome"`: `lentWhat([], false, true, false, true)` equals `the internet connection and your Chrome`. Use the `listOf` output the existing tests assert.

- [ ] **Step 2: Run, expect FAIL**: `npx vitest run src/components/BrowserProfilesManager.test.ts src/components/CloudLending.test.ts`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** the same command plus `npx vitest run src/locales` and `pnpm exec tsc -b --noEmit` (or the repo's `pnpm typecheck` if present), and expect PASS.

- [ ] **Step 5: Commit** `feat(ui): My Chrome on My Cloud in browser profiles, and the Your Chrome switch`

### Task 8: End to end through a real Cloud home, plus the docs

**Files:**
- Create: `server/cloud-lending-chrome.e2e.test.ts` (modelled on `server/cloud-lending-browser.e2e.test.ts`: a real Cloud home server, the real `createComputerSharing` connector)
- Modify: `docs/cloud-pro.md` (the lending scopes section, and the bullet that refuses DevTools on a lent screen, which should say Chrome is lent only by its own switch, over the device link, to the port the computer finds itself), `docs/plans/browser-engine.md` ("Where it applies"), `docs/browser-packaging.md` (the "on Cloud and servers profiles stay built-in" line)

**Interfaces:**
- Consumes everything above.

- [ ] **Step 1: Write the e2e tests.** The fake Chrome is the Task 2 fixture. The computer's connector gets `chrome: { dirs: [tmpWithDevToolsActivePort] }` through `createComputerSharing`'s existing test seams (add a `chrome` option next to `egress` if there is none). The client is a `ws` client playing agent-browser, connecting to the URL from the Cloud's `browserIntegration` for a bot whose profile is `browser: "chrome"`.
  - `"a Cloud bot's My Chrome browser reaches the person's Chrome through the lent computer"`: the person lends with `{ chrome: true }`. `GET /api/config` shows `browserEngine.myChrome === true` and `myChromeOn.online === true`. A `Browser.getVersion` frame reaches the fake Chrome and its answer comes back. Activity records a `chrome` entry.
  - `"a computer that stops lending Chrome takes the route with it"`: re-save the grant without `chrome`. The next connection through the door answers `HTTP/1.1 502`, and a tool-call refusal says `turn on Your Chrome`.
  - `"a conversation someone else wrote in cannot reach the person's Chrome"`: a thread with a line from another sender. Its turn's claim drops the open connection, and its tool call is refused with the someone-else sentence.

- [ ] **Step 2: Run** `npx vitest run server/cloud-lending-chrome.e2e.test.ts` and expect PASS once the seams are added.

- [ ] **Step 3: Update the three docs** in the same plain style as the surrounding text.

- [ ] **Step 4: Full check**: `npx vitest run server/ src/components/BrowserProfilesManager.test.ts src/components/CloudLending.test.ts` and `pnpm test:electron`. Only the known local failures may remain.

- [ ] **Step 5: Commit** `test(cloud): My Chrome on My Cloud end to end; docs`
