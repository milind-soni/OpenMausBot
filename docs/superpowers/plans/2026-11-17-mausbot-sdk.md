# MausBot SDKs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript and Python packages named `mausbot` that call a bot through the Bot API's new `/v1` address, plus a Developers section in the docs.

**Architecture:** The server answers the Bot API at `/hooks/api/v1/bots/<id>/messages` as well as the old path; on `/v1` only, a failed or stopped job answers `{thread, status: "failed", error}`. Each SDK is a thin client over that one address (send, read, wait, ask), with one shared list of recorded exchanges (`sdks/contract/cases.json`) that both SDKs replay against a stub server. A TypeScript end-to-end test runs the SDK against a real server with the fake engine.

**One deviation from the spec:** only the TypeScript SDK runs against a real server. The Python SDK replays the same recorded exchanges, and the TypeScript end-to-end test plus the server tests keep those exchanges true to the server. Running Python inside the Node test lanes would cost more than it catches.

**Tech Stack:** Node 24 server (TypeScript, vitest); TypeScript SDK with no runtime dependencies (global `fetch`); Python SDK on `httpx`, tested with `pytest` (async tests through anyio's pytest plugin, which ships with httpx's anyio dependency); Fumadocs MDX for the docs.

**Spec:** `docs/superpowers/specs/2026-11-17-mausbot-sdk-design.md`

## Global Constraints

- Work on branch `feat/mausbot-sdk`, cut from `docs/mausbot-sdk-design`. Never push, publish to npm or PyPI, or open a PR: Omkar does that.
- The unversioned path `/hooks/api/bots/<id>/messages` keeps answering exactly as it does today. Every existing test in `server/bot-api-host.test.ts` and `server/bot-api.e2e.test.ts` passes unchanged.
- No other Bot API behaviour changes: confinement, "acts as me", the plan gate and the rate limits stay as they are.
- The `error` in a `failed` answer is a fixed caller-facing sentence, never the engine's cause. A failure answers `COULD_NOT_ANSWER` ("The bot could not answer. Open this thread in the app to see why."). A stop answers `STOPPED_IN_APP` = "Someone stopped this in the app." The cause stays on the card for the person, as today.
- Both packages are named `mausbot` and start at version `0.1.0`.
- TypeScript SDK: no runtime dependencies, Node 18+ (`"engines": {"node": ">=18"}`), ESM, server-side only.
- Python SDK: `requires-python = ">=3.9"` (use `from __future__ import annotations`, no `match`, no runtime `X | Y`), one dependency `httpx>=0.27,<1`.
- Environment variables: `MAUSBOT_BOT_URL` (the address on the bot's Bot API card) and `MAUSBOT_BOT_KEY`. Trim both.
- Never put the key in an error message, a log line or a `repr`/`toString`.
- Defaults: `maxRetries` 2; `retryDelay` 0.5 s, doubling; `ask`/`wait` `timeout` 600 s; `pollInterval` 2 s, ×1.5 per poll, capped at 10 s. The SDK sends `wait` only when the caller sets it (the server's default is already 50 s).
- Retry only `GET`, on a network error or any 5xx. Never retry a `POST`.
- The same error class names in both SDKs: `MausBotError` (base); `APIStatusError` (base for HTTP errors, has `status` and `body`, the parsed JSON or undefined/None); `BadRequestError` (400, 413, 415), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429, `retryAfter` / `retry_after` in seconds or unset), `ServerError` (5xx), `ServerTooOldError` (404 whose `error` is exactly "Unknown webhook endpoint"). The rest extend `MausBotError`: `APIConnectionError`, `WaitTimeoutError` (has `thread`), `JobFailedError` (has `thread`; message = server's `error`), `NotSentError` (has `thread`). Any other 4xx raises plain `APIStatusError`. HTTP errors carry the server's `error` text as their message, or `HTTP <status>` when the body isn't JSON.
- Docs use the product name MausBot and the voice of the existing docs pages. No new components.

## Review Focus

1. **The card's address pasted as is**, including a local desktop address (`http://127.0.0.1:8799/hooks/api/bots/b1/messages`), a trailing slash, or a key with a trailing newline from a `.env` file. Expect it to work. Tests: config tests in Tasks 3 and 5.
2. **A proxy's HTML error page** (Fly or Cloudflare answering 502 with `text/html`). Expect `ServerError` with status 502, not a JSON parse crash. Test: contract case `proxy-html-502` (Task 3).
3. **`wait` on a thread already waiting for an approval.** Expect `NeedsApproval` after one `GET`, not polling until the timeout. Test: contract case `wait-on-approval` (Task 3).
4. **A status value the SDK doesn't know** (a newer server that broke the v1 rule). Expect a `MausBotError` naming the value, not an endless poll. Test: contract case `unknown-status` (Task 3).
5. **Unicode in messages and replies** (emoji, accents). Expect them sent and returned unchanged. Test: contract case `replies` uses "Héllo 👋" (Task 3).

---

### Task 1: Server: `/v1` address and failed jobs

**Files:**
- Modify: `server/bot-api-host.ts` (`PUBLIC_PATH` near line 28, `threadState` near line 146, `runCall` near 203–213, the door near 216–300)
- Modify: `shared/bot-api.ts` (add the v1 answer type)
- Modify: `docs/bot-api.md`
- Test: `server/bot-api-host.test.ts`

**Interfaces:**
- Produces: `BotApiV1Reply = BotApiReply | { thread: string; status: "failed"; error: string }` exported from `shared/bot-api.ts`. The wire shape every later task relies on: on `/v1`, HTTP 200 with that body for a failed or stopped job.

- [ ] **Step 1: Write the failing tests** in `server/bot-api-host.test.ts`, inside `describe("the Bot API door on the webhook receiver")`. First give the harness's `call` an `init.v1?: boolean` that puts `/v1` in the path.

```ts
it("answers on /v1 exactly as on the old path", async () => {
  // replies("Hello"): v1 POST → { status: 200, body: { reply: "Hello", thread } }; GET ?thread= on v1 → same body
});
it("on /v1 a turn that fails after 'working' reads back as failed; the old path still reads it as a reply", async () => {
  // script: on finish(), append { role: "bot", kind: "activity", tool: failedTurnTool("the engine is gone") }, then onSettled({ ok: false, text: "the engine is gone" })
  // POST { message, wait: 0 } → 202 working; finish(); 
  // v1 GET → { status: 200, body: { thread, status: "failed", error: "The bot could not answer. Open this thread in the app to see why." } }
  // old GET → { status: 200, body: { reply: "", thread } }
});
it("on /v1 a turn someone stopped in the app reads back as failed with the stop words", async () => {
  // finish(): append { role: "bot", kind: "activity", tool: { name: PERSON_STOPPED_TURN_NAME, ok: true } }, onSettled({ ok: true, text: "" })
  // v1 GET → body { thread, status: "failed", error: "Someone stopped this in the app." }
});
it("on /v1 a stop inside the wait answers failed with the stop words", async () => {
  // script: after 20 ms append the PERSON_STOPPED_TURN_NAME row, onSettled({ ok: true, text: "" })
  // v1 POST → { status: 200, body: { thread, status: "failed", error: "Someone stopped this in the app." } }
});
it("on /v1 a failure the person retried, which then replied, reads as the reply", async () => {
  // failure row, then { role: "bot", kind: "text", text: "Second go" } → v1 GET → { reply: "Second go", thread }
});
it("on /v1 a turn that fails inside the wait answers failed, and the card keeps the cause", async () => {
  // script: onDispatchError("the engine is gone") after 20 ms; v1 POST → { status: 200, body: { thread, status: "failed", error: COULD_NOT_ANSWER words } }
  // h.manager.listAttempts("b1").at(-1) toMatchObject({ statusCode: 502, reason: "the engine is gone" })  // the same row as today's 502
});
```

Import `failedTurnTool` from `../shared/failed-turn.ts` and `PERSON_STOPPED_TURN_NAME` from `../shared/client-cancel.ts`.

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run server/bot-api-host.test.ts`
Expected: the six new tests FAIL (v1 path answers 404 "Unknown webhook endpoint"); all existing tests PASS.

- [ ] **Step 3: Implement** in `server/bot-api-host.ts`:
  - `PUBLIC_PATH = /^\/hooks\/api\/(?:(v1)\/)?bots\/([\w-]{1,128})\/messages$/`. `const v1 = match[1] === "v1"; const botId = match[2]!;`
  - `const STOPPED_IN_APP = "Someone stopped this in the app.";`
  - `function endedWithout(lines: readonly Message[]): "failed" | "stopped" | null`. Find the last activity row that is a failure (`tool.ok === false`, `failedTurnCause(tool.name) !== null`, and `tool.partial !== true`) or a stop (`isStoppedTurnName(tool.name)`). Return its kind, but return `null` if any bot text line with content comes after it.
  - `threadState(botId, threadId, v1: boolean)`. After the `needs_approval` and `working` checks, on v1 only: `failed` → `{ thread, status: "failed", error: COULD_NOT_ANSWER }`, `stopped` → `{ ..., error: STOPPED_IN_APP }`. The GET answers 200 for a `failed` body.
  - `runCall(..., v1: boolean)`. On v1, once the turn has started, answer `{ status: 200, body: { thread, status: "failed", error } }` in two cases:
    - where today's code calls `fail(502, COULD_NOT_ANSWER, …)` (on `dispatchError` or `!settled.ok`), with `error: COULD_NOT_ANSWER`;
    - when a settled turn's `endedWithout(after())` is not `null`, with `STOPPED_IN_APP` for `"stopped"` and `COULD_NOT_ANSWER` for `"failed"`.

    The door records the call exactly as today's code would have recorded the same turn (a 502 failure keeps its `outcome: "rejected"`, `statusCode: 502`, `reason: <cause>` row), so the card doesn't change.

- [ ] **Step 4: Run the tests**

Run: `pnpm exec vitest run server/bot-api-host.test.ts server/bot-api-fence.test.ts server/bot-api.test.ts`
Expected: PASS, with no change to any existing test.

- [ ] **Step 5: Update `docs/bot-api.md`.** Add:
  - the `/v1` address, and the rule from the spec: within v1, only optional request fields and new response fields may be added. A new `status` value, a removed or renamed field, or a changed status code needs `/v2`.
  - the full list of status codes (add 405, 503 for a backup or restore in progress, and 409 for a moved workspace).
  - `failed` on `/v1`, with its two `error` sentences.

  Keep `/v1` out of the card's `curl` (`botApiCurl`) in this branch.

- [ ] **Step 6: Commit**

```bash
git add server/bot-api-host.ts server/bot-api-host.test.ts shared/bot-api.ts docs/bot-api.md
git commit -m "feat(bot-api): answer on /v1, where a failed or stopped job says so"
```

---

### Task 2: Contract cases

**Files:**
- Create: `sdks/contract/cases.json`
- Create: `sdks/contract/README.md` (the format, in under 30 lines)

**Interfaces:**
- Produces: the file both SDK runners read. Its format:

```json
{ "bot": "b1", "key": "k_test",
  "cases": [ {
    "name": "replies",
    "call": { "method": "ask", "message": "Héllo 👋", "options": {} },
    "exchanges": [
      { "request": { "method": "POST", "body": { "message": "Héllo 👋" } },
        "response": { "status": 200, "body": { "reply": "Bonjour 👋", "thread": "t1" } } } ],
    "result": { "status": "replied", "reply": "Bonjour 👋", "thread": "t1" } } ] }
```

  - `call.method` is `send | thread | wait | ask`. `call.thread` is set for `thread` and `wait`, and `options` holds the method's options with camelCase keys (Python maps them to snake_case).
  - `request` has `method`, plus `body` (exact JSON) for a POST or `query` (`{"thread": "t1"}`) for a GET. The path is always `/hooks/api/v1/bots/b1/messages` and the header `authorization: Bearer k_test`.
  - `response` has `status` and either `body` (JSON) or `rawBody` plus `contentType`, an optional `headers`, or `"drop": true` (close the socket without answering). `"repeat": true` on the last exchange answers every later request the same way.
  - The case ends with either `result` (the normalised answer) or `error` (`type` plus any of `status`, `thread`, `retryAfter`, `message`).
  - The runner fails a case if a request arrives that the exchanges don't list. That's how "never a second POST" is checked.

- [ ] **Step 1: Write `cases.json`** with these cases. Every case passes `options` `{"pollInterval": 0.01, "retryDelay": 0}`, unless noted.

| name | call | exchanges (request → response) | expected |
|---|---|---|---|
| replies | ask "Héllo 👋" | POST → 200 reply "Bonjour 👋" t1 | replied |
| polls-until-reply | ask | POST → 202 working t1; GET → 202 working; GET → 200 reply "Done" | replied "Done" |
| needs-approval | ask | POST → 202 needs_approval t1 | `{status: needs_approval, thread: t1}` |
| failed-after-working | ask | POST → 202 working; GET → 200 failed (COULD_NOT_ANSWER) | JobFailedError t1, that message |
| failed-in-wait | ask | POST → 200 failed (STOPPED_IN_APP) | JobFailedError |
| send-as-is | send `{wait: 0}` | POST body `{message, wait: 0}` → 202 working | `{status: working, thread: t1}` |
| thread-once | thread t1 | GET → 200 reply | replied |
| continues | ask `{thread: t1}` | POST body `{message, thread: t1}` → 200 reply | replied |
| busy-then-send | ask `{thread: t1}` | POST → 409 `{thread: t1, status: working}`; GET → 200 reply "Earlier"; POST → 200 reply "Later" | replied "Later" |
| busy-on-approval | ask `{thread: t1}` | POST → 409 working; GET → 202 needs_approval | NotSentError t1 |
| wait-on-approval | wait t1 | GET → 202 needs_approval | needs_approval, one GET |
| times-out | wait t1 `{timeout: 0.1}` | GET → 202 working, repeat | WaitTimeoutError t1 |
| post-429 | ask | POST → 429 "Too many calls: this key takes 10 a minute" | RateLimitError, no retryAfter |
| post-429-retry-after | ask | POST → 429 + `retry-after: 3600` | RateLimitError retryAfter 3600 |
| post-409-busy | ask | POST → 409 `{error: "The bot is busy. Try again soon."}` | ConflictError |
| post-502 | ask | POST → 502 `{error}` | ServerError 502 |
| post-dropped | ask | POST → drop | APIConnectionError |
| get-503-retried | thread t1 | GET → 503 backup words; GET → 200 reply | replied |
| get-gives-up | thread t1 | GET → 503, repeat (3 requests allowed) | ServerError 503 |
| get-dropped-retried | thread t1 | GET → drop; GET → 200 reply | replied |
| proxy-html-502 | ask | POST → 502 `rawBody "<html>Bad gateway</html>"`, `text/html` | ServerError 502, message "HTTP 502" |
| bad-key | ask | POST → 401 "Invalid key" | AuthenticationError |
| api-off | ask | POST → 403 "The Bot API is off for this bot" | PermissionDeniedError, that message |
| no-thread | thread tX | GET → 404 "no such thread" | NotFoundError |
| old-server | ask | POST → 404 "Unknown webhook endpoint" | ServerTooOldError |
| bad-body | ask | POST → 400 `{error}` | BadRequestError |
| unknown-status | thread t1 | GET → 202 `{thread: t1, status: "queued"}` | MausBotError, message contains "queued" |

- [ ] **Step 2: Check the file parses and the names are unique**

Run: `node -e 'const c=require("./sdks/contract/cases.json").cases; const n=new Set(c.map(x=>x.name)); if(n.size!==c.length) throw 1; console.log(c.length)'`
Expected: `27`

- [ ] **Step 3: Commit**

```bash
git add sdks/contract
git commit -m "test(sdk): the Bot API v1 exchanges both SDKs must replay"
```

---

### Task 3: TypeScript SDK

**Files:**
- Create: `sdks/typescript/package.json`, `sdks/typescript/tsconfig.json`, `sdks/typescript/README.md`
- Create: `sdks/typescript/src/index.ts` (re-exports only), `src/http.ts`, `src/errors.ts`, `src/bot.ts`
- Test: `sdks/typescript/test/contract.test.ts`, `sdks/typescript/test/config.test.ts`
- Modify: `pnpm-workspace.yaml` (add `"sdks/typescript"`), `pnpm-lock.yaml` (via `pnpm install`), `vite.config.ts` (add `"sdks/typescript/**/*.test.ts"` to `include`), root `package.json` (`typecheck` gains `&& tsc -p sdks/typescript/tsconfig.json --noEmit`), `scripts/ci-scope.mjs`

**Interfaces:**
- Consumes: `sdks/contract/cases.json` (Task 2); the `/v1` wire shape (Task 1)
- Produces (from `sdks/typescript/src/index.ts`):

```ts
export type Answer = { status: "replied"; reply: string; thread: string } | { status: "needs_approval"; thread: string };
export type ThreadState = Answer | { status: "working"; thread: string } | { status: "failed"; thread: string; error: string };
export interface BotOptions { endpoint?: string; baseUrl?: string; botId?: string; key?: string; maxRetries?: number; retryDelay?: number; fetch?: typeof fetch }
export interface WaitOptions { timeout?: number; pollInterval?: number }   // seconds
export class Bot {
  constructor(options?: BotOptions);
  send(message: string, options?: { thread?: string; wait?: number }): Promise<ThreadState>;
  thread(id: string): Promise<ThreadState>;
  wait(id: string, options?: WaitOptions): Promise<Answer>;
  ask(message: string, options?: { thread?: string; wait?: number } & WaitOptions): Promise<Answer>;
}
// src/http.ts: workspace-ready, nothing bot-specific
export interface HttpConfig { baseUrl: string; key: string; maxRetries: number; retryDelay: number; fetch: typeof fetch }
export function request(config: HttpConfig, init: { method: "GET" | "POST"; path: string; query?: Record<string, string>; body?: unknown }): Promise<{ status: number; body: unknown }>;
// plus every error class named in Global Constraints, from src/errors.ts
```

- [ ] **Step 1: Write the failing tests.**
  - `contract.test.ts`: `it.each(cases)`. For each case, start a `node:http` stub on `127.0.0.1:0` that checks each incoming request against the next exchange (method, path, query, exact JSON body, bearer key) and answers it; a request with no exchange left fails the case. Build `new Bot({ baseUrl: stub, botId: "b1", key: "k_test", retryDelay: 0 })`, call `case.call`, then assert `toEqual(case.result)`, or that the error is an instance of the class named by `error.type` and matches its listed fields.
  - `config.test.ts`:

```ts
it("rewrites the card's address to /v1, including a local desktop address and a trailing slash")
  // endpoint "http://127.0.0.1:8799/hooks/api/bots/b1/messages/" → requests go to http://127.0.0.1:8799/hooks/api/v1/bots/b1/messages
it("keeps an address that already has /v1")
it("reads MAUSBOT_BOT_URL and MAUSBOT_BOT_KEY, trimmed")   // key "k_test\n" → header "Bearer k_test"
it("refuses a missing key or an address that isn't a Bot API address, at construction")
it("never puts the key in an error message")   // key "k_secret_123"; 401 case → String(error) and JSON.stringify(error) don't contain it
```

- [ ] **Step 2: Run them and see them fail**

Run: `pnpm exec vitest run sdks/typescript`
Expected: FAIL (`Bot` is not exported).

- [ ] **Step 3: Implement.**
  - `src/http.ts`: `request` retries a GET up to `maxRetries` times on `APIConnectionError` or status ≥ 500, waiting `retryDelay · 2^n` seconds. It never retries a POST. It sends `content-type: application/json` on a POST, parses JSON when the body parses, and otherwise keeps `undefined`.
  - `src/errors.ts`: `errorFor(status, body, headers)` picks the class by the table in Global Constraints. `retry-after` is parsed as whole seconds.
  - `src/bot.ts`: normalise a `{reply, thread}` body to `{status: "replied", …}`. Any other `status` outside `working | needs_approval | failed` throws `MausBotError` naming it.
    - `wait` polls `thread` until the answer isn't `working`. `failed` throws `JobFailedError`. When the deadline passes it throws `WaitTimeoutError`.
    - `ask` calls `send`. A `ConflictError` whose body is `{thread, status: "working"}` makes `ask` wait for that thread: if the wait ends at `needs_approval` it throws `NotSentError`, and otherwise it calls `send` once more. A `working` answer goes on to `wait`, and `failed` throws `JobFailedError`.
  - `package.json`: `"name": "mausbot"`, `"version": "0.1.0"`, `"type": "module"`, `"exports": {".": {"types": "./dist/index.d.ts", "default": "./dist/index.js"}}`, `"files": ["dist"]`, `"engines": {"node": ">=18"}`, `"scripts": {"build": "tsc -p tsconfig.json"}`, no `dependencies`, `"license": "Apache-2.0"`.
  - `README.md`: install, the quickstart from the spec, errors, retries.

- [ ] **Step 4: Wire it into the repo.** Make these edits, then run `pnpm install`:
  - `pnpm-workspace.yaml`: add the package.
  - `vite.config.ts`: add the test include.
  - root `typecheck` script: add the SDK.
  - `scripts/ci-scope.mjs`:
    - in `AREAS`, next to `[/^relay\//, "relay"]`, add `[/^sdks\/typescript\//, "sdk-typescript"]` and `[/^sdks\/contract\//, "sdk-contract"]`;
    - in `AREA_CHECKS`, add `"sdk-typescript": ["build", "linux-tests"]` and `"sdk-contract": ["linux-tests"]` (Task 5 adds `sdk-python` to the second).
    - If `scripts/ci-scope.test.ts` pins the area list, update it the same way.

- [ ] **Step 5: Run the tests and checks**

Run: `pnpm exec vitest run sdks/typescript scripts/ci-scope.test.ts && pnpm typecheck && pnpm --filter mausbot build && pnpm lint`
Expected: PASS. `sdks/typescript/dist/index.js` and `dist/index.d.ts` exist (add `dist` to `.gitignore` if the root ignore doesn't already cover it).

- [ ] **Step 6: Commit**

```bash
git add sdks/typescript pnpm-workspace.yaml pnpm-lock.yaml vite.config.ts package.json scripts/ci-scope.mjs scripts/ci-scope.test.ts
git commit -m "feat(sdk): mausbot for TypeScript, on the Bot API's /v1"
```

---

### Task 4: TypeScript SDK against a real server

**Files:**
- Test: `sdks/typescript/test/real-server.e2e.test.ts`

**Interfaces:**
- Consumes: `Bot` (Task 3); `launchVerificationServer` from `scripts/control-omb.ts`, used the way `server/bot-api.e2e.test.ts` uses it (lines 46–95: switch the API on through the app's route, take the key it returns)

- [ ] **Step 1: Write the test**

```ts
it("asks a bot on a real server through the card's own address and gets its reply", async () => {
  // fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_VERSION: "2.1.284" })
  // switch the Bot API on for a new bot; endpoint = the card's address (unversioned)
  // const answer = await new Bot({ endpoint, key }).ask("Hello")
  // expect(answer).toMatchObject({ status: "replied", thread: expect.any(String) }); expect(answer.reply.length).toBeGreaterThan(0)
});
it("raises AuthenticationError for a wrong key on a real server", async () => { /* same fixture, key "wrong" */ });
```

- [ ] **Step 2: Run it**

Run: `pnpm exec vitest run sdks/typescript/test/real-server.e2e.test.ts`
Expected: PASS. If it fails, the cause is in Task 1 or Task 3. Fix it there, not by loosening this test.

- [ ] **Step 3: Commit**

```bash
git add sdks/typescript/test/real-server.e2e.test.ts
git commit -m "test(sdk): the TypeScript SDK against a real server and the fake engine"
```

---

### Task 5: Python SDK

**Files:**
- Create: `sdks/python/pyproject.toml`, `sdks/python/README.md`
- Create: `sdks/python/src/mausbot/__init__.py`, `_http.py`, `_errors.py`, `_types.py`, `_bot.py`, `py.typed`
- Test: `sdks/python/tests/test_contract.py`, `sdks/python/tests/test_config.py`
- Modify: `.github/workflows/ci.yml` (new job `sdk-python`), `scripts/ci-scope.mjs`

**Interfaces:**
- Consumes: `sdks/contract/cases.json` (Task 2)
- Produces (from `mausbot`):

```python
@dataclass(frozen=True)
class Replied: reply: str; thread: str; status: Literal["replied"] = "replied"
class NeedsApproval: thread: str; status = "needs_approval"
class Working: thread: str; status = "working"
class Failed: thread: str; error: str; status = "failed"
Answer = Union[Replied, NeedsApproval]; ThreadState = Union[Replied, NeedsApproval, Working, Failed]

class Bot:
    def __init__(self, endpoint: str | None = None, key: str | None = None, *, base_url: str | None = None,
                 bot_id: str | None = None, max_retries: int = 2, retry_delay: float = 0.5,
                 http_client: httpx.Client | None = None) -> None: ...
    def send(self, message: str, *, thread: str | None = None, wait: float | None = None) -> ThreadState: ...
    def thread(self, thread_id: str) -> ThreadState: ...
    def wait(self, thread_id: str, *, timeout: float = 600, poll_interval: float = 2) -> Answer: ...
    def ask(self, message: str, *, thread: str | None = None, wait: float | None = None,
            timeout: float = 600, poll_interval: float = 2) -> Answer: ...
class AsyncBot: ...  # the same, async, on httpx.AsyncClient
# every error class named in Global Constraints; RateLimitError.retry_after
```

- [ ] **Step 1: Write the failing tests.**
  - `test_contract.py`: parametrize over `cases.json`, once for `Bot` and once for `AsyncBot` (`@pytest.mark.anyio`, `anyio_backend = "asyncio"`). The stub is a `http.server.ThreadingHTTPServer` on `127.0.0.1:0` in a daemon thread, applying the same checks as the TypeScript runner. Map `options` keys to snake_case, and compare `result` against `dataclasses.asdict(answer)`.
  - `test_config.py`: the same five cases as Task 3's `config.test.ts`, in Python. "Never in an error message" checks `str(err)` and `repr(err)`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd sdks/python && python3 -m venv .venv && .venv/bin/pip install -q -e ".[dev]" && .venv/bin/pytest -q`
Expected: FAIL with `ImportError` (or collection errors) for `mausbot.Bot`.

- [ ] **Step 3: Implement**, mirroring Task 3's behaviour exactly (same retry rules, same `ask` logic, same normalisation and unknown-status error). `pyproject.toml`: hatchling build, `name = "mausbot"`, `version = "0.1.0"`, `requires-python = ">=3.9"`, `dependencies = ["httpx>=0.27,<1"]`, `[project.optional-dependencies] dev = ["pytest>=8"]`, license Apache-2.0. Add `sdks/python/.venv/` to `.gitignore`.

- [ ] **Step 4: Run the tests**

Run: `cd sdks/python && .venv/bin/pytest -q`
Expected: PASS (54 contract runs + 5 config tests).

- [ ] **Step 5: Wire CI.**
  - **`ci.yml`:** add job `sdk-python`, modelled on the `relay` job. It needs `static` and runs if `contains(needs.static.outputs.jobs, '"sdk-python"')`, on `ubuntu-latest` with `working-directory: sdks/python`. Steps: checkout (the same pinned SHA as relay), then `python3 -m venv .venv`, `.venv/bin/pip install -e ".[dev]"`, `.venv/bin/pytest -q`. It uses the runner's own Python and adds no new action. Add it wherever `ci.yml` lists `relay` as a gated job (the CI gate's `needs` and its result check).
  - **`scripts/ci-scope.mjs`:**
    - add `"sdk-python"` to `SELECTABLE_JOBS`;
    - add `[/^sdks\/python\//, "sdk-python"]` to `AREAS`;
    - add `"sdk-python": ["sdk-python"]` to `AREA_CHECKS`;
    - make `"sdk-contract"` `["linux-tests", "sdk-python"]`.

- [ ] **Step 6: Run the CI checks**

Run: `pnpm exec vitest run scripts/ci-scope.test.ts scripts/ci-workflow.test.ts scripts/ci-linux-lanes.test.ts`
Expected: PASS (update their fixtures where they pin the job or area lists).

- [ ] **Step 7: Commit**

```bash
git add sdks/python .github/workflows/ci.yml scripts/ci-scope.mjs scripts/*.test.ts .gitignore
git commit -m "feat(sdk): mausbot for Python, sync and async, with its own CI job"
```

---

### Task 6: Developers section in the docs

**Files:**
- Create in `apps/docs/content/docs/developers/`:
  - `meta.json` (`"title": "Developers"`, `"icon": "Code"`, pages `index, bot-api, sdks, cli, mcp-server`)
  - `index.mdx`, `bot-api.mdx`, `cli.mdx`, `mcp-server.mdx`
  - `sdks/meta.json`, `sdks/typescript.mdx`, `sdks/python.mdx`
- Modify: `apps/docs/content/docs/meta.json` (add `"developers"` after `"mobile"`)

**Interfaces:**
- Consumes: the public names from Tasks 3 and 5 (examples must use them exactly); `docs/bot-api.md` (Task 1); `docs/headless-cli.md`; `docs/mcp-server.md`

- [ ] **Step 1: Write `index.mdx`** in the order the spec gives (§5):
  1. Two lines on what MausBot gives developers.
  2. CLI: one `<Card>`.
  3. Client SDKs: `<Cards>` with TypeScript and Python. Under them, a versions table (both `0.1.0`) and the line "Each major SDK version uses one Bot API version."
  4. Integrations: MCP server.
  5. "Building agents?": one line pointing to bots and routines.
  6. A `<Callout>` on keys: a key reads whatever the bot can read, so keep it on a server; "acts as me" makes it as powerful as the owner.

- [ ] **Step 2: Write the other pages.**
  - `bot-api.mdx`: the outside-caller parts of `docs/bot-api.md`, using the `/v1` address.
  - `sdks/*.mdx`: install, quickstart (`MAUSBOT_BOT_URL`, `MAUSBOT_BOT_KEY`), `ask` / `send` / `thread` / `wait`, the error table, and what the SDK retries and why.
  - `cli.mdx` and `mcp-server.mdx`: the user-facing parts of their `docs/` sources.
  - Say the packages aren't on npm or PyPI yet only if they still aren't when this merges. Leave a `{/* TODO(publish) */}` MDX comment where the install command goes, for Omkar to remove when he publishes.

- [ ] **Step 3: Build the docs**

Run: `pnpm --filter @openmausbot/docs types:check && pnpm --filter @openmausbot/docs lint && pnpm docs:build`
Expected: PASS. The build lists `/docs/developers`, `/docs/developers/bot-api`, `/docs/developers/sdks/typescript`, `/docs/developers/sdks/python`, `/docs/developers/cli` and `/docs/developers/mcp-server`.

- [ ] **Step 4: Commit**

```bash
git add apps/docs/content/docs
git commit -m "docs: a Developers section, with the CLI, the SDKs and the MCP server"
```

---

## Finish

- [ ] Run the full set once. Expected: PASS.

  ```bash
  pnpm exec vitest run server/bot-api-host.test.ts server/bot-api.e2e.test.ts sdks/typescript scripts/ci-scope.test.ts scripts/testing/file-size-ratchet.test.ts scripts/testing/comment-history.test.ts
  pnpm typecheck
  pnpm lint
  cd sdks/python && .venv/bin/pytest -q
  ```

- [ ] Hand back to Omkar with:
  - the branch name;
  - Milind's sign-off needed on Task 1;
  - publishing and name reservation still his.
