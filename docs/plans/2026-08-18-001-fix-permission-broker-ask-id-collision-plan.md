---
title: "fix: Reject colliding ask ids in the permission broker"
plan_type: fix
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
created: 2026-08-18
---

# fix: Reject colliding ask ids in the permission broker

## Summary

`createPermissionBroker()` in [server/drivers/claude.ts](server/drivers/claude.ts) registers every incoming `{t:"ask", id, ...}` message into a shared `pending` Map keyed by `askId`, with no check for an existing entry. Two asks arriving with the same id — across any connection on the broker, since `pending` is server-scoped, not per-connection — silently collide: the second `pending.set()` overwrites the first, `onAsk` still fires for both (two `request.opened` cards can appear), and when the *first* ask's `finish()` later runs, `pending.delete(askId)` removes the second (still-displayed) entry too, leaving it permanently unanswerable — a zombie card via id collision, distinct from the post-close timing class fixed for #211.

This plan adds an ingestion-time guard that detects a colliding id **before** `onAsk` fires or `pending` is touched, auto-denies the colliding ask directly on its own connection, and leaves the original pending entry untouched. It also documents why real-world collision is very unlikely (both ask producers mint a fresh `randomUUID()` per ask, with no retry/replay path that reuses one) and adds regression coverage for the guard.

## Problem Frame

**Root cause:** [server/drivers/claude.ts:245](server/drivers/claude.ts#L245) — `pending.set(askId, { ask, finish })` runs unconditionally on every parsed `ask` line, regardless of whether `askId` is already a key in `pending`.

**Why it matters even though collision is rare:** the failure mode is silent and asymmetric — a legitimate first ask can be permanently orphaned by a later id collision it has no way to detect, and the user is left with an unanswerable UI card and no diagnostic. A cheap ingestion-time guard turns an unbounded, hard-to-debug failure into an observable, fail-safe one.

**Scope:** `server/drivers/claude.ts`'s `createPermissionBroker()` only. `server/permission-proxy.ts` (the id producer) is investigated but not modified — its `randomUUID()` generation is already correct.

## Investigation Finding (documents Requirement 1)

Both ask producers mint a fresh id per ask, with no path that resends an existing id:

- [server/permission-proxy.ts:107](server/permission-proxy.ts#L107) — `const askId = randomUUID();` runs once per `tools/call` (`approve` or `ask_user`), inside the MCP `tools/call` handler. Each call gets its own `Promise` registered in the proxy's local `waiting` map keyed by that same id; there is no retry loop that reuses an id after a timeout or error — a fresh `tools/call` from the CLI always mints a fresh id.
- [server/drivers/claude.ts:226](server/drivers/claude.ts#L226) — the broker's own fallback, `const askId = String(msg.id ?? newId())`, only fires when the incoming message omits `id` entirely, and `newId()` ([server/contracts.ts:304](server/contracts.ts#L304)) is `crypto.randomUUID()` — cryptographically random, not a counter.

Realistic collision sources are therefore: (a) astronomically unlikely UUID collision, or (b) a buggy or adversarial client on the permission socket sending a hand-crafted duplicate `id`. Neither is a legitimate retry/replay path — this confirms the guard is a defense-in-depth fix for a currently-hypothetical but real class of bug (and for any future ask producer that does not mint ids as carefully), not a fix for an observed collision.

## Key Technical Decisions

**KTD1 — Guard fires at ingestion, before `onAsk`/`pending.set`, not inside `finish`.** Checking `pending.has(askId)` immediately after parsing the line and rejecting there means the colliding ask never becomes a UI card and the original pending entry is never touched. Rejected alternative: letting both asks through and trying to disambiguate in `finish`/`answer` by giving the second entry a synthetic key — this still creates a zombie card in the UI (since `onAsk` already fired) and adds complexity to `answer()`'s public contract for a case that should never reach the UI at all.

**KTD2 — Auto-deny the colliding ask on its own connection, do not silently drop it.** The proxy side (`server/permission-proxy.ts:117`) is `await new Promise` waiting on a `t:"answer"` for its `askId` — if the broker drops the line instead of answering, that `tools/call` hangs until the CLI's own timeout (if any) rather than failing fast. Sending back `{t:"answer", id, behavior:"deny", message}` immediately keeps the contract every caller of the socket already expects (`server/permission-proxy.ts:49-53` matches `t==="answer"` by id and resolves its waiter) and fails closed, consistent with the existing broker philosophy at [server/drivers/claude.ts:250-252](server/drivers/claude.ts#L250-L252) ("keep the turn fail-closed, but leave an actionable diagnostic").

**KTD3 — Log via `console.error`, matching the existing broker diagnostic pattern.** [server/drivers/claude.ts:253-255](server/drivers/claude.ts#L253-L255) already logs broker-unavailable errors this way; a colliding-id log line follows the same convention rather than introducing a new logging channel or telemetry event type for what is expected to be a near-never-fired guard.

**KTD4 (session-settled: user-directed — chosen over bundling into the #211 branch/PR: the bug is a distinct, out-of-scope class from #211's post-close timing bug)** — this fix ships as its own PR on a fresh branch off `main`, not folded into the #211 zombie-card fix.

## Implementation Units

### U1. Guard against colliding ask ids in `createPermissionBroker()`

**Goal:** Detect an incoming `ask` whose `id` already has a live entry in `pending`, auto-deny it on its own connection without registering it or invoking `onAsk`, and leave the original pending entry untouched.

**Requirements:** Investigation Finding above (documents why the guard is defense-in-depth); KTD1, KTD2, KTD3.

**Dependencies:** None.

**Files:**
- `server/drivers/claude.ts` (modify `createPermissionBroker`, roughly lines 219–246)
- `server/drivers/claude.test.ts` (new test — see U2)

**Approach:**
1. Immediately after `const askId = String(msg.id ?? newId());` (line 226) and before constructing `ask`/`finish`/`timer`, check `if (pending.has(askId))`.
2. On collision: write `{t:"answer", id: askId, behavior:"deny", message: <fixed diagnostic string>}` to `conn` (guard the write in `try/catch`, matching the existing style at line 232-234), `console.error` a one-line diagnostic naming the socket path and colliding id, and `continue` the `while` loop — skip constructing `ask`, `finish`, `timer`, `pending.set`, and `opts.onAsk` entirely for this line.
3. Do not touch the existing entry in `pending` for that id in any way; it resolves exactly as it would have without the collision.
4. Introduce one exported or module-scope constant for the deny message (e.g. alongside `QUESTION_TIMEOUT_NOTE`/`DENY_TIMEOUT_NOTE`) rather than an inline string literal, matching the file's existing convention for user-facing broker messages.

**Patterns to follow:** the existing timeout-deny messages `QUESTION_TIMEOUT_NOTE`/`DENY_TIMEOUT_NOTE` and their use in the `finish` timeout branch (lines 237-243); the `server.on("error", ...)` diagnostic-logging convention (lines 253-255); the `try { conn.write(...) } catch {}` pattern already used for answer writes (lines 232-234).

**Test scenarios:**
- Happy path (no regression): a normal single ask still registers in `pending`, still fires `onAsk`, and still resolves via `answer()` — covered by existing tests in `claude.test.ts`; no new happy-path test needed here beyond confirming existing tests still pass.
- Collision, same connection: two `{t:"ask", id:"dup-1", ...}` lines written back-to-back on the same socket connection before the first is answered. Expect exactly one `request.opened` event for `dup-1`, and the second `ask` line is answered on the wire with `{t:"answer", id:"dup-1", behavior:"deny", ...}` while the first ask's own `pending` entry remains resolvable afterward by `answer("dup-1", "allow")`. Covers the connection-write half of KTD1/KTD2.
- Collision, cross-connection: an ask with id `dup-2` is opened on one connection; a second connection (simulating a second proxy) sends an `ask` with the same id `dup-2` before the first resolves. Expect the second connection receives an immediate deny answer, no second `request.opened` fires, and the first connection's pending entry for `dup-2` still resolves correctly via `answer()`. This is the scenario the bug report specifically calls out (`pending` is server-scoped, not per-connection).
- Post-resolution reuse is *not* a collision: after `dup-3` is answered (its `pending` entry removed via `finish`), a brand-new ask reusing id `dup-3` is accepted normally (registers, fires `onAsk`, answerable). Confirms the guard only blocks a *live* collision, not id reuse after resolution — an important boundary since `pending.delete` already frees the key.

**Verification:** All four scenarios above pass; existing `claude.test.ts` permission-broker tests (lines 341-410) continue to pass unmodified.

### U2. Regression test for the id-collision guard

**Goal:** Add automated coverage for U1's guard in `server/drivers/claude.test.ts`, following the existing socket-level test pattern used for the permission broker.

**Requirements:** U1's test scenarios above.

**Dependencies:** U1 (guard must exist for the test to assert against).

**Files:**
- `server/drivers/claude.test.ts` (new `it(...)` blocks in the existing permission-broker `describe` block, near lines 341-410)

**Approach:**
1. Follow the existing pattern at [server/drivers/claude.test.ts:341-380](server/drivers/claude.test.ts#L341-L380): `create("hang")`, send a turn, wait for `session.started`, `connect(permissionSocketPath(threadId))`, write raw `{t:"ask", ...}` JSON lines, and assert on `recorder` events (`request.opened`) and on raw socket reads (the `{t:"answer", ...}` line).
2. For the same-connection collision scenario, reuse one `conn` for both `ask` writes and collect both answer lines by buffering on `data` (the existing `answered` promise pattern only resolves once — extend it to collect an array of parsed lines, or resolve two separate promises keyed by array index).
3. For the cross-connection scenario, open two `connect(...)` sockets against the same `permissionSocketPath(threadId)` and write one ask on each.
4. For the post-resolution reuse scenario, answer the first ask via `instance.adapter.respondToRequest(...)` (as in the existing test at line 372) before writing the second `ask` line with the same id, then assert the second one *does* produce a `request.opened`.
5. Clean up every opened `conn` with `conn.end()` and finish each test by interrupting the turn and awaiting `turn.completed`, matching existing tests.

**Patterns to follow:** [server/drivers/claude.test.ts:341-410](server/drivers/claude.test.ts#L341-L410) — the three existing permission-broker tests, especially the raw-socket write/read helpers and the `recorder.until(...)` assertions.

**Test scenarios:** (implements U1's scenarios as executable tests — no separate list; see U1's "Collision, same connection", "Collision, cross-connection", and "Post-resolution reuse is not a collision" scenarios verbatim.)

**Verification:** `npm test -- server/drivers/claude.test.ts` (or the project's equivalent test command) passes, including the three new cases, with no changes needed to unrelated existing tests in the file.

## Scope Boundaries

**In scope:** the `createPermissionBroker()` ingestion guard in `server/drivers/claude.ts`, its regression tests, and documenting the investigation finding.

**Out of scope:**
- The #211 post-close timing fix (`fix/claude-turn-teardown-zombie-teardown-cards` branch) — already a separate, merged/pending change.
- Modifying `server/permission-proxy.ts`'s id generation — investigation confirmed it already mints correctly.
- Any telemetry/metrics pipeline beyond the existing `console.error` diagnostic convention.

### Deferred to Follow-Up Work
None identified — this is a small, self-contained defensive fix.

## Verification Contract

- Existing permission-broker tests in `server/drivers/claude.test.ts` (lines 341-410) continue to pass unmodified.
- New tests (U2) cover: same-connection collision, cross-connection collision, and post-resolution id reuse (non-collision).
- Manual reasoning check: confirm the guard never fires `opts.onAsk` for a colliding id (no zombie card is ever created, as opposed to created-then-orphaned).

## Definition of Done

- [ ] `createPermissionBroker()` rejects a colliding `askId` at ingestion with an immediate deny answer and a diagnostic log, per KTD1-KTD3.
- [ ] The original pending entry for a colliding id is provably unaffected (still resolves normally).
- [ ] Regression tests for same-connection collision, cross-connection collision, and post-resolution reuse are added and passing.
- [ ] No changes to `server/permission-proxy.ts`.
- [ ] Full test suite passes.
