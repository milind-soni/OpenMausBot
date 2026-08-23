---
title: "Fix Windows pipe-name collision in permission broker tests - Plan"
type: fix
date: 2026-08-18
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# Fix Windows pipe-name collision in permission broker tests

## Goal Capsule

Make PR #230's four new permission-broker collision tests pass on Windows by eliminating the named-pipe name collision between them: all four tests use thread ids that truncate to the same 8-char tag, producing the same Windows pipe name, and a lingering pipe from a prior test makes the next test's broker `listen()` fail with `EADDRINUSE`. The fix gives each test a unique thread id that yields a unique tag, plus a deterministic tag-uniqueness assertion so a re-collision fails on every platform, not just on a timing-dependent Windows run. The production collision guard in `server/drivers/claude.ts` is verified sound and stays untouched. Stop condition: `pnpm exec vitest run server/drivers/claude.test.ts` passes on macOS and Ubuntu, and the Windows `typecheck + test (windows-latest)` job is green on two consecutive runs.

## Product Contract

### Summary

The Windows CI job fails on PR #230 at exactly one test in the vitest run: `denies a colliding ask id from a second connection on the same broker`, with `Error: connect ENOENT \\.\pipe\openmausbot-perm-1892-t-perm-d`. The same job log shows the real cause: `permission broker unavailable on \\.\pipe\openmausbot-perm-1892-t-perm-d: listen EADDRINUSE: address already in use`. The broker for that test never started because the pipe name was already held by the previous collision test. All four collision tests produce the same pipe name. (The full `pnpm test` job also runs broker:test, updater, and packaged-server; those never executed in the failing run because `vitest run` exited non-zero first, so their Windows status is not evidenced by this run.)

### Problem Frame

`permissionSocketPath(threadId)` truncates the thread id to an 8-char tag (`server/drivers/claude.ts:192-195`). The four collision tests use thread ids `t-perm-dup-1`, `t-perm-dup-2`, `t-perm-dup-3`, `t-perm-dup-4`, which all truncate to `t-perm-d`. On Windows, `brokerSocketPath` builds `\\.\pipe\openmausbot-perm-<pid>-t-perm-d` (`server/procs.ts:114-119`).

On POSIX, `createPermissionBroker` calls `unlinkSync(opts.socketPath)` before `listen()` (`server/drivers/claude.ts:208-210`), which removes the previous test's socket file, so re-listening the same name succeeds. On Windows, `unlinkSync` on a `\\.\pipe\...` path is a no-op — a named pipe is not a filesystem entry. The OS holds the pipe name briefly after the prior broker's `server.close()`, so the next test's `listen()` fails with `EADDRINUSE` and the broker never starts. The test's `connectSocket` then fails with `ENOENT` because no pipe is listening. The observed run failed only 1 of the 4 same-name tests, confirming the release window is short and the failure is timing-dependent.

The pre-existing broker tests never hit this because they use distinct thread ids (`t-perm-abc`, `t-perm-stop`) with distinct tags. The production code is unlikely to hit this in normal operation because real thread ids are UUIDs, though the 8-char truncation remains a latent collision risk there — out of scope for this plan.

### Requirements

**Windows pipe-name isolation**

- R1. Each of the four collision tests must use a broker pipe name unique to that test, so no test's broker `listen()` can collide with a prior test's lingering pipe.

**Deterministic regression guard**

- R2. A platform-independent assertion verifies the four collision tests' thread ids yield four distinct `permissionSocketPath()` values, so a future tag re-collision fails on every platform instead of surfacing only as a timing-dependent Windows failure.

**Regression preservation**

- R3. All four collision tests keep their exact assertions: full deny payload (`id`, `behavior: "deny"`, `message`), exactly one `request.opened` per colliding id, the original ask still resolvable, and post-resolution id reuse accepted.

**Scope boundary**

- R4. No production file changes: `server/drivers/claude.ts` and `server/permission-proxy.ts` are unchanged by this plan. The 8-char tag truncation in `permissionSocketPath` is not modified.

**Verification**

- R5. `pnpm exec vitest run server/drivers/claude.test.ts` passes on macOS and Ubuntu (33 tests declared; 32 pass and 1 is skipped — the Windows-only pipe-naming test). The Windows `typecheck + test (windows-latest)` CI job is green on two consecutive runs.

## Planning Contract

### Key Technical Decisions

- KTD1. Fix the test thread ids, not the production tag logic. (session-settled: user-directed — chosen over modifying `permissionSocketPath`/`brokerSocketPath`: production behavior is correct for real UUID thread ids, and changing the tag scheme would alter production socket names and risk breaking the packaged app's pipe contract.)
- KTD2. Give each collision test a thread id whose 8-char tag is unique. Use ids that survive truncation: `t-dup-1`, `t-dup-2`, `t-dup-3`, `t-dup-4` → tags `t-dup-1`, `t-dup-2`, `t-dup-3`, `t-dup-4`, which are unique, collide with no other thread id in the file, and match the ask ids already used in each test. Rationale: the ask ids in the tests are already `dup-1`..`dup-4`; aligning the thread id to the ask id keeps the tests readable and guarantees unique tags.
- KTD3. No retry, no sleeps, and no workaround-style helper changes for the collision. (session-settled: user-directed — chosen over the bot's retry-with-backoff fix and over helper hardening: the log proves the failure is a pre-connect `EADDRINUSE`/`ENOENT` caused by pipe-name collision, which no connect retry or answer buffering can fix.) A dead-broker fail-fast improvement to `answerQueue` is deferred to follow-up, not part of this fix.
- KTD4. Verification must not rely on a single green Windows run, because the failure is timing-dependent (1 of 4 same-name tests failed in the observed run). Require the deterministic tag-uniqueness assertion (R2) plus two consecutive green Windows runs before the Definition of Done is met. Rationale: a no-op change could pass a single run by timing luck; the deterministic assertion and the two-run gate remove that ambiguity.

### Sources

- Windows job log (admin-gated, obtained via authenticated `gh`): `permission broker unavailable on \\.\pipe\openmausbot-perm-1892-t-perm-d: listen EADDRINUSE: address already in use` followed by `Error: connect ENOENT \\.\pipe\openmausbot-perm-1892-t-perm-d` on the `denies a colliding ask id from a second connection on the same broker` test.
- `server/drivers/claude.ts:192-195` — `permissionSocketPath` 8-char tag truncation.
- `server/procs.ts:114-119` — Windows named-pipe name construction with `process.pid`.
- `server/drivers/claude.ts:208-210` — `unlinkSync` before `listen()` (POSIX-only effective).
- `server/drivers/claude.test.ts:438-561` — the four collision tests with thread ids `t-perm-dup-1..4`.

## Implementation Units

### U1. Give each collision test a unique pipe name and assert tag uniqueness

**Goal:** No two collision tests share a broker pipe name on any platform, and any future tag re-collision fails deterministically.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** None.

**Files:** `server/drivers/claude.test.ts` (thread ids in the four tests at lines 438-561; a new assertion block in the same file).

**Approach:**
1. Change the thread id in each of the four collision tests so its 8-char tag is unique: `t-perm-dup-1` → `t-dup-1`, `t-perm-dup-2` → `t-dup-2`, `t-perm-dup-3` → `t-dup-3`, `t-perm-dup-4` → `t-dup-4`.
2. Keep the ask ids (`dup-1`..`dup-4`) unchanged; they already match the new thread id suffix, keeping the tests readable.
3. Confirm each `permissionSocketPath("<threadId>")` call in the test body uses the new thread id consistently (conn, respondToRequest, interruptTurn).
4. Add a small deterministic assertion in the same file (e.g. in the `ClaudeDriver.decodeConfig` describe block or a dedicated `it`): `expect(new Set(["t-dup-1", "t-dup-2", "t-dup-3", "t-dup-4"].map(permissionSocketPath)).size).toBe(4)`. This runs on every platform and fails on any future tag re-collision.

**Test scenarios:**
- All four collision tests still pass on POSIX with their exact assertions (R3) — the change is only the pipe name.
- The new tag-uniqueness assertion passes on POSIX and Windows (R2): `permissionSocketPath("t-dup-1")` → tag `t-dup-1`, etc., all distinct.
- Reasoning check: `t-dup-1..4` collide with no other thread id in the file (the other broker tests use `t-perm-abc`, `t-perm-stop`, `t-perm-2`; all tags distinct).

**Verification:** `pnpm exec vitest run server/drivers/claude.test.ts` passes on macOS/Ubuntu; Windows CI job is green on two consecutive runs.

## Verification Contract

- `pnpm exec vitest run server/drivers/claude.test.ts` — 33 tests declared; on Windows, 33 pass; on macOS and Ubuntu, 32 pass and 1 is skipped (the Windows-only pipe-naming test at line 66).
- `pnpm typecheck` — clean.
- Full `pnpm test` on macOS (vitest + broker:test + updater + packaged-server).
- The Windows `typecheck + test (windows-latest)` job is green on two consecutive runs. If it is not, obtain the job log (authenticated `gh api repos/milind-soni/OpenMausBot/actions/jobs/<id>/logs`) and name the failing test before any further change; do not guess a second fix.

## Definition of Done

- [ ] U1 landed: the four collision tests use unique thread ids/tags; no two share a pipe name.
- [ ] The tag-uniqueness assertion (R2) is present and passes on all platforms.
- [ ] All four collision tests retain their exact assertions and pass.
- [ ] No production files changed (`server/drivers/claude.ts`, `server/permission-proxy.ts` clean in the diff).
- [ ] macOS and Ubuntu: claude test file and full `pnpm test` pass; typecheck clean.
- [ ] Windows CI job is green on two consecutive runs.

## Deferred to Follow-Up

- `answerQueue` error/close rejection: add `error`/`close` handlers so a dead broker rejects pending waiters with a named error instead of hanging to the 20 s vitest timeout. Not part of this fix — it was not the failure mode (the broker never started in the failing test, so no waiter was ever pending on a dead connection), and the new branches would ship without an exercising test. If added later, it needs a scenario that actually kills a broker mid-test and asserts the named rejection.
- Windows-equivalent of the broker's POSIX-only `unlinkSync`-before-listen: the platform asymmetry is the root cause; a later hardening could retry-on-`EADDRINUSE` or otherwise release the name. Out of scope here because unique names sidestep the collision.
