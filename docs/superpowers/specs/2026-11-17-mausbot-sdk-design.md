# MausBot SDKs and the Developers docs section

Date: 2026-11-17. Status: design, waiting for Omkar's approval. Needs a read from Milind, who owns the Bot API.

## Why

Developers should be able to call MausBot bots from their own code. Today they can paste a `curl` command from a
bot's Bot API card, or use the `openmausbot` CLI, but there is no package to install and no developer section in
the docs. The model is Anthropic's "CLI, SDKs & libraries" page
(platform.claude.com/docs/en/cli-sdks-libraries/overview): one page that lists the CLI, a client SDK per language, and
the integrations, each with its own page.

## What exists today

- **Bot API** (`docs/bot-api.md`, `server/bot-api-host.ts`, `shared/bot-api.ts`; Milind, 2026-11-02, "acts as me"
  added 2026-11-16 in #6176). A bot can be switched on for outside calls and gets one key.
  `POST <base>/hooks/api/bots/<botId>/messages` with `{message, thread?, wait?}` answers `200 {reply, thread}`,
  `202 {thread, status: "working" | "needs_approval"}`, or `{error}` with 400, 401, 403, 404, 405, 409, 413, 415, 429,
  502 or 503. `docs/bot-api.md` doesn't list three of these: 405 (a method other than GET or POST), 503 (a workspace
  backup or restore is running, `server/workspace-backup-maintenance.ts`), and the 409 a moved workspace gives
  (`server/move-freeze.ts`).
  `GET …/messages?thread=<id>` reads a thread the API opened. It works on desktop, self-hosted servers and Cloud
  (anywhere `/hooks` is reachable). Cloud Starter answers 403 (the gate is enforced by Cloud, so it holds). By
  default a key's calls run confined: Ask, no tools, text replies only. A key the owner marks "acts as me" runs at
  the bot's own level.
- **Headless CLI** (`docs/headless-cli.md`, `server/headless/`): `openmausbot bots | run | send | wait | messages |
  interrupt | events | export | token create …`, driving a whole workspace with a workspace token (client or admin
  scope).
- **MCP server** (`docs/mcp-server.md`, `scripts/mcp-server.ts`, `openmausbot mcp`): about 20 tools over the
  internal `/api/*` routes. The CLI calls these tool handlers in-process.
- **Docs site** (`apps/docs`, Fumadocs, docs.openmausbot.com): no developer or API section.
- **Package names:** `mausbot` is free on npm and on PyPI (checked 2026-11-17). Not reserved yet.

## Goals

1. A TypeScript SDK and a Python SDK, both named `mausbot`, that call the Bot API: send a message, continue a
   thread, wait for the reply, read a thread.
2. A version marker on the Bot API, so each major SDK version is tied to one API version (as on Claude's page).
3. A **Developers** section in the docs, with the overview page in the shape of Claude's: CLI, SDKs, integrations,
   and a "building agents?" pointer.
4. Contract tests that run both SDKs against a real server, so a change to the Bot API that breaks an SDK fails CI.

## Non-goals (v1)

- The workspace API (list bots, channels, interrupt, live events, create bots). It comes later in the same package
  (see "Room for the workspace API").
- Languages beyond TypeScript and Python.
- Changes to the Bot API's behaviour or safety rules: confinement, "acts as me", the plan gate, rate limits. The
  one exception is reporting failed jobs on the new `/v1` path (below).
- SDK snippets on the Bot API card in the app (a follow-up; it touches desktop and phone UI).
- A machine-readable versions file like Claude's `sdk-versions.json`.

## Anti-goals (a failure even if it works)

- An SDK that can turn a key's "acts as me" on or off, or any other owner setting. That stays in the app, owner only.
- An SDK that makes a call run twice: a retry that starts a second turn on the bot.
- Encouraging keys in browser code. A key reads whatever the bot can read; the TypeScript SDK is for servers.
- Freezing the internal `/api/*` routes by building on them.

## Approaches considered

1. **SDK on the Bot API now, workspace API later in the same package.** *Picked.* The Bot API is already public,
   documented, keyed, rate-limited, plan-gated and reachable on Cloud, and it has the shape of Claude's Messages
   API. It needs only a version marker from the server.
2. **Bot API only, for good.** Same v1, but no plan for workspace control from code. Rejected because developers
   will want to list bots and stream events, and the package should not need renaming then.
3. **A new public workspace `/v1` API first** (Claude's earlier recommendation, before the Bot API turned up). Covers
   all the CLI does, but adds a second way to sign in and a second set of safety rules next to the Bot API's. Kept as
   the later step, not the first.

Also rejected: SDKs on the internal `/api/*` routes (freezes them), and SDKs that drive the MCP server (text results
written for models, and Python would need Node).

## Design

### 1. Bot API version 1 (server)

- Accept `/hooks/api/v1/bots/<botId>/messages` as well as today's path, handled by the same code. Change the
  `PUBLIC_PATH` pattern in `server/bot-api-host.ts`; nothing else in the handler changes.
- The unversioned path stays working, unchanged, for anyone who pasted the card's `curl`.
- Version 1 is today's contract: the request fields `message`, `thread`, `wait`; the answers `{reply, thread}` and
  `{thread, status}`; `{error}` on failure; the limits in `docs/bot-api.md`; and every status code the path really
  answers (the full list under "What exists today"). Add the three missing codes to `docs/bot-api.md`.
- **Failed jobs, on `/v1` only** (Omkar, 2026-11-17). Today a turn that fails, or that someone stops in the app,
  after the POST answered `202 working` reads back as `200 {reply: "", thread}`: `threadState` in
  `bot-api-host.ts` collects only the bot's text lines, and a failed turn is saved as an activity row
  (`packages/phone-protocol/src/failed-turn.ts`). If the same failure happens inside the POST's own wait, the
  caller gets a 502. On the `/v1` path, both the GET and the POST answer `{thread, status: "failed", error}`
  instead, where `error` is the reason in the caller's words ("stopped in the app" for a stop). The unversioned
  path keeps answering as it does today, so no pasted `curl` changes behaviour. This touches Milind's code and needs
  his OK before it's built.
- Within v1, the server may add optional request fields and new response fields. A new `status` value, a removed
  or renamed field, or a changed status code is a breaking change and needs `/v2`.
- Write this rule into `docs/bot-api.md` and the new docs page.
- Whether the card's `curl` (from `botApiCurl` in `shared/bot-api.ts`) moves to the `/v1` path is the builder's
  call. The card exists only on desktop: the phone apps read a thread's `botApi` flag and nothing else (checked in
  mausbot-mobile, 2026-11-17).

### 2. TypeScript SDK (`mausbot` on npm)

Where: `sdks/typescript/` in this repo, added to `pnpm-workspace.yaml`. No runtime dependencies: global `fetch`, so it
runs on Node 18+, Bun, Deno and edge runtimes. Server-side only (see anti-goals). It may import types from
`shared/bot-api.ts` at build time, but the published package must not depend on the app.

The shape (names are the builder's call; the behaviour is the design):

```ts
import { Bot } from "mausbot";

const bot = new Bot({
  endpoint: process.env.MAUSBOT_BOT_URL, // the address on the bot's Bot API card
  key: process.env.MAUSBOT_BOT_KEY,
});

const answer = await bot.ask("What's on my calendar tomorrow?");
// { status: "replied", reply, thread } | { status: "needs_approval", thread }
await bot.ask("Move the 3pm to Friday", { thread: answer.thread });

const sent = await bot.send("Start the weekly report", { wait: 0 }); // one POST, the server's answer as is
const now = await bot.thread(sent.thread);                         // one GET
const done = await bot.wait(sent.thread, { timeout: 600 });         // keeps reading until it is not "working"
```

- **Config.** `endpoint` accepts the card's full address (the SDK rewrites it to the `/v1` path), or `baseUrl` plus
  `botId`. With no options, read `MAUSBOT_BOT_URL` and `MAUSBOT_BOT_KEY` from the environment. Never log the key or
  put it in an error message.
- **`ask`** = `send` (default `wait` 50 s, under the proxy limit `BOT_API_DEFAULT_WAIT_MS` was chosen for), then
  `wait` while the answer is `working`. It returns `needs_approval` as a result, not an error: a person answers it in
  the app, and the caller can `wait` again later. Default overall timeout: 10 minutes, then a timeout error that
  carries the thread id so the caller can pick it up. A `status: "failed"` answer raises a job-failed error that
  carries the thread id and the server's `error` text.
- **`wait`** reads the thread with `GET` (backing off from about 2 s to 10 s). GETs are not counted against the
  10-a-minute limit: the GET branch in `bot-api-host.ts` returns before the limiter.
- **Errors.** One base error with `status` and the server's `error` text, and one subclass each for 400/413/415,
  401, 403, 404, 409, 429 (with `retryAfter` when the `retry-after` header is set), 5xx/502, network failure and
  timeout. 403 covers four different causes (API off, plan upgrade, AI can't run confined, key no longer acts as
  owner). Pass the server's text through; don't parse it into codes.
- **Retries, which must never start a second turn.** The SDK retries only `GET`, on a network error, a 5xx or a 503
  (default twice, with backoff). It never retries a `POST` on its own in v1. It raises the error, with `retryAfter`
  when the server sent `retry-after`, and the caller decides. *(Claude's call, after the builder check.)*

  Why: some refused POSTs store nothing (the per-key 429, the busy 409s), and some store the message first (the
  spend-cap 429 on a continued thread). Today you can tell them apart only by the shape of the response (does a
  `retry-after` header come with it, does the body have `{error}` or `{thread, status}`). v1 doesn't promise those
  shapes, so building retries on them could cause the double turn the anti-goals forbid. If safe POST retries are
  wanted later, the server adds a field that says so (for example `retryable: true`, allowed within v1), agreed with
  Milind, and the SDK then retries only when that field says it may.
- **`ask` on a thread that is still busy** (POST answers 409 `{thread, status: "working"}`, refused before
  anything is stored): wait for the thread with `GET`, then send once. If the wait ends at `needs_approval`, don't
  send. Raise an error that says the message was not sent because the thread is waiting for an approval in the
  app. Returning `needs_approval` would make the caller think their new message is the one waiting.
  *(Claude's call.)*
- **An older server.** A server without the `/v1` path answers 404 `"Unknown webhook endpoint"`
  (`server/webhook-ingress.ts`). Raise a clear error that says the server needs updating for this SDK, not a plain
  404. *(Claude's call.)*

### 3. Python SDK (`mausbot` on PyPI)

Where: `sdks/python/`. Python 3.9+, one dependency (`httpx`). It matches the TypeScript SDK call for call, with
`Bot` and `AsyncBot` (sync and async, as Anthropic's Python SDK does), typed results (`TypedDict` or dataclasses,
builder's call), the same errors, retries, defaults and environment variables.

```python
from mausbot import Bot

bot = Bot()  # MAUSBOT_BOT_URL, MAUSBOT_BOT_KEY
answer = bot.ask("What's on my calendar tomorrow?")
if answer.status == "replied":
    print(answer.reply)
```

### 4. Contract tests

- One shared list of cases in `sdks/contract/` (request, the server's answer, what the SDK must return or raise).
  Both SDKs run them.
- Run them against a real server with the fake engine, the same way `server/bot-api.e2e.test.ts` does
  (`launchVerificationServer` in `scripts/control-omb.ts`). That way a change to `bot-api-host.ts` that breaks the v1 contract fails in this
  repo's CI, not in a developer's app.
- Cover the retry rules above with a stub server: no SDK call may ever produce a second stored message.
- Cover failed jobs: a turn that fails after `202 working` reads back as `status: "failed"` on `/v1`, and as
  today's `200` on the unversioned path.

### 5. Docs: a Developers section

Add `apps/docs/content/docs/developers/` and put it in the root `meta.json` (after `mobile` is a sensible place).
The pages:

| Page | Source |
|---|---|
| `index.mdx`: overview in the shape of Claude's page | new |
| `bot-api.mdx`: the HTTP reference, with versioning | the outside-caller parts of `docs/bot-api.md` |
| `sdks/typescript.mdx`, `sdks/python.mdx`: install, quickstart, errors, retries, timeouts | new |
| `cli.mdx`: the headless CLI | `docs/headless-cli.md` |
| `mcp-server.mdx`: MausBot as an MCP server | `docs/mcp-server.md` |

The overview page, top to bottom:

1. Two lines on what MausBot gives developers: the CLI, client SDKs, integrations.
2. **CLI**: one card, `openmausbot`, "drive a workspace from scripts, CI and other agents".
3. **Client SDKs**: cards for TypeScript and Python. Below them, a short versions table (written by hand at each
   release) and one line saying each SDK major version uses one Bot API version.
4. **Integrations**: one card, MCP server.
5. **Building agents?**: one line pointing to bots, routines and the app, for people who want MausBot to run the
   agent loop rather than call it.
6. One plain note on keys: a key reads whatever the bot can read; keep it on a server; "acts as me" makes it as
   powerful as the owner.

Write in the docs site's existing voice and components. No new design work.

### 6. Releases

- SDK versions are independent of the app's (`0.1.x`). Start at `0.1.0`. Go to `1.0.0` once Milind has signed off
  on the v1 contract.
- Publishing to npm and PyPI is Omkar's call, as are reserving the names and choosing the account and org. Until
  then the packages build and test in CI but are not published. Use trusted publishing (npm provenance, PyPI
  trusted publisher) when it happens.

### 7. Room for the workspace API

Not built now. To keep the door open:

- Package name `mausbot`, not `mausbot-bot-api`. `Bot` is a named export, so a workspace `MausBot` client can be
  added next to it.
- The SDK's HTTP layer (base URL, auth header, errors, retries) does not assume one bot, so a workspace client can
  reuse it with a workspace token.
- When the workspace API is designed, start from the shapes the MCP tools already return (`projectBot`,
  `projectMessage`, the `wait_for_conversation` statuses) and move that projection to the server. Then the CLI,
  the MCP server and the SDK can all share it.

## Decided in conversation (Omkar, 2026-11-17)

- Purpose: developers call bots from their own code (real SDKs, not only a docs page).
- Target: the developer's own workspace first (desktop or self-hosted), built so Cloud works with no code change.
  The Bot API already reaches Cloud.
- Approach: SDK on the Bot API now, workspace API later, in one package.
- Failed jobs: `/v1` reports them as `status: "failed"` with an `error`; the old path is unchanged. Needs Milind's OK.

## Proposed by Claude, open to correction

- TypeScript and Python first. Package name `mausbot` on both registries.
- Versioning by URL path (`/v1`) rather than a header.
- Default timeouts (50 s per call, 10 minutes for `ask`) and the retry rules above.
- Packages live in this repo under `sdks/`.

## Left to the builder

Exact class, method and error names; how the TypeScript package is built and bundled; the Python typing style;
where the Developers section sits in the nav; whether the card's `curl` moves to `/v1`; how the contract cases are
written down.
