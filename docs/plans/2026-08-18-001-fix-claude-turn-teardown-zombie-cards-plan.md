---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# fix: Kill the child process and drop late asks on Claude turn teardown

**Origin issue:** [milind-soni/OpenMausBot#211](https://github.com/milind-soni/OpenMausBot/issues/211) — "Turn teardown discards the permission broker without ensuring child CLI/MCP exit — late approval requests become dead 'zombie' cards"

---

## Summary

When a Claude-driven turn ends, `server/drivers/claude.ts`'s `settle()` tears down the permission broker and forgets the turn — but never kills the spawned `claude -p --resume` child. If the child (or an MCP grandchild doing backgrounded work) doesn't exit on its own, it can later emit a new permission ask on its still-open broker connection. Because `net.Server.close()` doesn't touch already-open sockets, that ask is still processed and surfaces as a `request.opened` card — but the turn's `active` entry (and the broker reference the UI needs to answer it) is already gone, so the card can never be resolved. The fix makes `settle()` unconditionally kill the child's process tree and makes the broker's `close()` actually stop honoring asks on any connection, closed or not.

## Problem Frame

`sendTurn()` in `server/drivers/claude.ts` spawns the `claude` CLI per turn and wires a `createPermissionBroker()` instance to a per-turn unix socket (named pipe on Windows). The CLI's own spawned MCP `ogb` process (`server/permission-proxy.ts`) forwards `approve`/`ask_user` tool calls over that socket to the broker, which the harness renders as `request.opened` cards.

Two independent gaps compound into the reported symptom:

1. **The child is never killed on teardown.** `settle()` (invoked from the `result` stream-json frame, a spawn `error`, or an exit-before-`result` `close`) deletes the turn from `active` and closes the broker, but nothing calls `killCliTree(child)` — that utility is only wired to `interruptTurn` (an explicit user stop). A `-p` one-shot CLI process is expected to exit right after printing `result`, but if it (or a grandchild doing `run_in_background` work) doesn't, it keeps running with no teardown-side enforcement.

2. **A closed broker still answers still-open connections.** `createPermissionBroker.close()` calls `server.close()`, which per Node's `net` docs "stops the server from accepting new connections" but does **not** touch sockets that already connected. The `conn.on("data", ...)` handler registered in `createNetServer((conn) => {...})` stays fully wired to any live connection — a lingering child's MCP proxy can still send a `{t:"ask",...}` message, which the handler happily adds to the (still-referenced-via-closure) `pending` Map and forwards via `opts.onAsk(ask)`, emitting a brand-new `request.opened` event. But `active.delete(threadId)` already ran inside `settle()`, so `respondToRequest` finds no broker for that thread and returns `"unavailable"` — the exact unanswerable "Auto mode couldn't answer this one" card the issue describes.

**Prior art in this codebase:** `server/drivers/antigravity.ts` already tracks live children independently of `active` (a `children: Set<ChildProcess>`) and reaps them via `reapChildren(escalate)` — `killCliTree` first, then an optional SIGKILL after a 2s grace on POSIX when `escalate` is set. That mechanism is only invoked from `stopAll()`/`dispose()` (whole-driver shutdown), not per-turn, so it does not by itself close this gap — but its escalation shape is the right reference for this fix.

## Requirements

- **R1**: On every terminal path of a Claude turn (successful `result`, spawn `error`, or exit-before-`result`), the spawned child's entire process tree must be forcibly terminated as part of teardown — not left to exit on its own, and not deferred to `interruptTurn`/`stopAll`/`dispose`.
- **R2**: A permission/question ask that arrives after the broker for that turn has been closed must never become an actionable `request.opened` UI event, and must not leave the caller's MCP tool call hanging forever. It must be resolved with a system-source deny/answer written directly to the still-open connection — the same shape `close()` already uses for in-flight `pending` asks — never surfaced as a card, and never a silent drop (see KTD2: `server/permission-proxy.ts` has no independent per-ask timeout, so a silent drop leaves that `tools/call` promise pending indefinitely).
- **R3**: Neither fix may change behavior for the already-working case: a turn whose child exits promptly and cleanly after `result`, with no late asks, must produce the exact same event sequence and `turn.completed` payload as today.
- **R4**: `killCliTree`'s existing contract (SIGTERM to the process group on POSIX, forceful `taskkill /T /F` on Windows) must not regress — this fix reuses it, not forks it.

## Scope Boundaries

**In scope:** `server/drivers/claude.ts` (`settle()` and `createPermissionBroker()`), its test file `server/drivers/claude.test.ts`, and the shared fake CLI `server/testing/fake-claude-cli.ts` (a new mode to reproduce a post-`result` lingering child).

**Out of scope:**
- The issue's "point 3" (a startup sweep that reaps orphans left over from a crash where teardown itself never ran). Different failure mode — crash recovery, not normal-path leak — requiring process-marker scanning across the whole app at startup. Deferred to follow-up.
- `server/drivers/codex.ts` and `server/drivers/acp/core.ts` share the structurally identical `const stop = () => killCliTree(child);`-only-on-`interruptTurn` pattern and likely the same latent defect, but the reported issue is specifically about `claude -p --resume`. Same shape of fix, separate surface — deferred to follow-up, not folded into this PR.
- Rewiring `antigravity.ts`'s `reapChildren` to also run per-turn (it has its own driver-specific `children` tracking already; touching it is unrelated to this issue).

### Deferred to Follow-Up Work
- Startup orphan sweep (issue's point 3).
- Porting the same per-turn kill-on-settle + drop-late-asks fix to `codex.ts` and `acp/core.ts`.

## Key Technical Decisions

**KTD1: Kill the child directly inside `settle()`, reusing `killCliTree` as-is — no SIGTERM-then-SIGKILL escalation added at this call site.**
Rationale: `killCliTree` already does a full-strength kill per platform (POSIX: `SIGTERM` to the process group, which is the same signal `antigravity.ts`'s non-escalated path sends; Windows: `taskkill /T /F`, already forceful — escalation is a documented no-op there). `server/kill-tree.test.ts` proves this reaps a grandchild reliably *when that grandchild stays in the spawned child's process group* — which is the case for an ordinary MCP server the CLI spawns without `detached: true` itself. `antigravity.ts`'s SIGKILL-after-grace escalation exists for its `dispose()`/`stopAll()` path, which reaps a *set* of potentially-many children at once and can afford a shared grace window; retrofitting a per-turn `setTimeout` here for a single child adds a timer to manage (and to account for in tests) for a benefit `kill-tree.test.ts` doesn't show is needed. If real-world SIGTERM stalls turn out to matter later, `antigravity.ts`'s escalation is there to copy.
**Known limitation, explicitly out of scope:** if a grandchild deliberately re-detaches itself (calls its own `spawn(..., { detached: true })`/`setsid`, escaping into a new process group — the classic daemonizing pattern), `process.kill(-pid, "SIGTERM")` on the original group will not reach it. `kill-tree.test.ts`'s existing grandchild does *not* self-detach, so it does not prove coverage of this case. No known MCP server this harness spawns (`permission-proxy.ts`, `computer-proxy`, `dweb-proxy`, `agents-proxy`) does this today, so this is a documented gap, not a live regression — but it means KTD1 does not fully close the "backgrounded work" scenario from the Problem Frame if that work ever re-detaches. Follow-up if it becomes a live issue: a kill-tree test with a self-detaching grandchild, and a stronger reaping strategy if it fails.
Alternative considered and rejected: add the same grace+SIGKILL escalation now — rejected as unjustified complexity without evidence a plain SIGTERM leaves processes behind in this codepath (unlike `antigravity.ts`, which already had multi-child cleanup to justify it), and because escalation doesn't help the self-detached case above anyway (a SIGKILL to the wrong process group is still a no-op).

**KTD2: Guard late asks with a `closed` boolean checked inside the connection's `data` handler; on a late ask, always write a system-source deny/answer to the connection — never a silent drop.**
Rationale: the simplest fix that satisfies R2 without changing `close()`'s existing contract for in-flight `pending` asks. The `data` handler already runs inside the closure that owns `pending`, `timeoutMs`, and now a `closed` flag set at the top of `close()`; checking it before creating a new pending entry is a one-line, easily-tested guard. Closure handling takes precedence over the active-turn duplicate-ID guard. **The response must be an explicit system-source deny/answer, not a silent drop:** permissions receive `deny` with `OpenMausBot: the turn ended`; questions receive `answer` with `OpenMausBot: the turn is ending — wrap up.` `server/permission-proxy.ts`'s `waiting` map (the child-side promise the CLI's `tools/call` is awaiting) is only resolved by an incoming `{t:"answer",...}` message or by the connection's own `error`/`close` firing `dead()` — nothing in `permission-proxy.ts` times out a single ask on its own. A silent drop on the broker side leaves that specific MCP tool call hanging until something else closes the connection, which is exactly the kind of hang R2 exists to prevent.
Alternatives considered and rejected: (a) track and destroy live connections in `close()` — rejected as more state for no additional correctness, since the goal is "never create an answerable-looking dead card," not "sever the pipe," and a killed child per KTD1 will sever it anyway in the common case; the `closed` flag plus an explicit reply covers the case where the child hasn't been killed yet. (b) reuse `active.has(threadId)` instead of a dedicated `closed` boolean, since `respondToRequest` already treats a missing `active` entry as "no active turn" — rejected because of an ordering hazard: `createPermissionBroker` is constructed *before* `active.set(threadId, ...)` runs in `sendTurn` (the broker needs to exist to build the MCP config passed to the spawn call), so `active.has(threadId)` would incorrectly read `false` during that brief legitimate startup window, denying an ask that arrives before the turn is even fully registered. A dedicated flag defaulting to `false` has no such window.

**KTD3: New fake-CLI mode `result-then-hang` for testing fix A; no new mode needed for fix B.**
Rationale: fix A's contract is about the OS process, not just emitted events — the existing `hang` mode never reaches `result`, so it can't prove "settle happened AND the process is gone." A new mode that prints `result` then calls the same idle-forever `setInterval` `hang` already uses is a minimal, symmetric addition. Fix B's test doesn't need a new CLI mode: it drives the broker directly over the socket exactly like the existing "brokers a permission ask" test, just with a second `{t:"ask",...}` sent after `turn.completed`/close — no CLI behavior involved.

## Implementation Units

### U1. Kill the child's process tree on every settle() path

**Goal:** Eliminate the leaked/lingering process (R1).

**Requirements:** R1, R3, R4

**Dependencies:** None

**Files:**
- `server/drivers/claude.ts` (modify `settle()`, ~line 472-489)
- `server/testing/fake-claude-cli.ts` (add `result-then-hang` mode)
- `server/drivers/claude.test.ts` (new test; test file path already exists)

**Approach:**
- In `settle()`, first call `broker?.close()` so closure is terminal and all current asks resolve, then call `killCliTree(child)` unconditionally before temp-dir cleanup, active-turn deletion, and `turn.completed`. `child` is already in scope (defined earlier in `sendTurn` at the `spawnCli` call); do not introduce a new binding or rely on the later-declared `stop` const.
- `killCliTree` is a no-op when the process already exited (`child.exitCode !== null || child.signalCode !== null`), so this is safe for the common case where the CLI has already exited by the time `result` is parsed and `settle()` runs — R3's no-regression requirement holds by construction.
- Add `result-then-hang` to `server/testing/fake-claude-cli.ts`: emit the same `system`/`assistant`/`user`/`result` sequence the default `happy` path does, then instead of `process.exit(0)`, call the same `setInterval(() => {}, 1_000)` the `hang` mode uses to stay alive.
- **The test needs the fake CLI's real OS pid to verify it's actually dead, and nothing today exposes it.** `ProviderInstance.adapter` has no pid accessor, and `FAKE_CLAUDE_DUMP`'s payload (`{argv, env, prompt, mcpConfig}`) doesn't carry one. Add `pid: process.pid` to the object `fake-claude-cli.ts` writes via `writeFileSync(process.env.FAKE_CLAUDE_DUMP, ...)` — reusing the existing dump mechanism rather than adding a new one — so the test can read it back the same way existing tests already read `argv`/`env` from that file.
- New test in `server/drivers/claude.test.ts`: set `FAKE_CLAUDE_DUMP` to a scratch path, run a turn in `result-then-hang` mode, wait for `turn.completed`, read the pid back from the dump file, then assert the underlying process is actually gone (poll `process.kill(pid, 0)` throwing, or an equivalent liveness check — see `server/kill-tree.test.ts`'s `alive()` helper for the established pattern) within a bounded timeout. This is the test that would fail today (child stays alive) and pass after the fix.

**Patterns to follow:** `server/kill-tree.test.ts`'s `alive(pid)` helper (POSIX signal-0 probe) for asserting process death without a platform-specific timeout guess.

**Test scenarios:**
- Happy path: `result-then-hang` mode — `turn.completed` still fires with the correct `ok`/`stopReason`/`usage` payload (unchanged from today), and the underlying process is verifiably dead shortly after.
- Regression/no-op check: default `happy` mode — turn completes exactly as today (same event sequence, same `turn.completed` fields) with `killCliTree` now also called (should be a harmless no-op since the process already exited).
- Edge case: `exit-early` mode (crash before result) — `killCliTree` runs from the `close` handler's `settle(false, "exit_before_result")` path too; confirm no error is thrown when calling `killCliTree` on an already-exited/crashed child.

**Verification:** Run `pnpm vitest run server/drivers/claude.test.ts` (or the repo's documented equivalent) locally; all existing tests in the file continue to pass, and the new `result-then-hang` test demonstrates the process is killed.

### U2. Drop permission/question asks that arrive after the broker has closed

**Goal:** Eliminate the unanswerable "zombie" card (R2).

**Requirements:** R2, R3

**Dependencies:** U1 (not a hard code dependency, but U1 removes the common trigger for this race; U2 is the correctness backstop for the remaining window between an ask being emitted and the kill signal actually landing)

**Files:**
- `server/drivers/claude.ts` (modify `createPermissionBroker`, ~line 196-278)
- `server/drivers/claude.test.ts` (new test)

**Approach:**
- Add a `let closed = false;` inside `createPermissionBroker`'s closure.
- At the top of the `conn.on("data", ...)` handler's per-line processing, after parsing `msg` but before duplicate-ID handling or creating the `Ask`/`pending` entry: if `closed` is true, write a system-source reply directly to `conn` — `{t:"answer", id: msg.id, behavior: "deny", message: "OpenMausBot: the turn ended"}` for a permission ask, or `{t:"answer", id: msg.id, behavior:"answer", message: "OpenMausBot: the turn is ending — wrap up."}` for a question — without registering a `pending` entry or calling `opts.onAsk`, then return. **This must always reply; per KTD2/R2, silently returning with no reply is not an option** — it leaves `permission-proxy.ts`'s corresponding `tools/call` promise hanging, since that file only resolves an ask on an explicit `{t:"answer"}` or its own connection `error`/`close`.
- Set `closed = true` as the first line of `close()`, before it iterates `pending`.
- Do not change what `close()` does with the existing `pending` Map — that behavior (system-source deny for permissions, system-source answer for questions) is correct and already tested.

**Patterns to follow:** The existing "brokers a permission ask into request.opened and answers over the socket" test's connection-driving style in `server/drivers/claude.test.ts` (`connect(permissionSocketPath(...))`, write a raw `{t:"ask",...}` line, read the JSON reply off `conn`).

**Test scenarios:**
- Happy path (regression): the existing "brokers a permission ask into request.opened and answers over the socket" test continues to pass unchanged — an ask sent while the turn is active still becomes `request.opened` and is answerable.
- Primary regression scenario: start a turn in `hang` mode, open a connection to the permission socket, send one ask and let it resolve (or just proceed without resolving), then call `interruptTurn` and **await `turn.completed`** (interrupt only calls `stop()`/`killCliTree`; `settle()` — which sets `closed = true` — only runs later, asynchronously, off the child's `close` event, so the test must wait for it rather than racing ahead), then send a **second** `{t:"ask",...}` on the **same still-open connection** — assert no new `request.opened` event is emitted for it, and that the connection receives the system-source deny/answer reply (never a bare drop with no reply).
- Edge case: an ask that was already `pending` when `close()` runs must still resolve via the existing system-source deny/answer path (this is the pre-existing "resolves a pending ask as a system denial when the turn is interrupted" test — confirm it still passes unchanged).

**Verification:** Run `pnpm vitest run server/drivers/claude.test.ts`; the new late-ask test demonstrates no `request.opened` fires for an ask sent after close, and all pre-existing broker tests in the file remain green.

## Verification Contract

- Both units are verified by extending the real, already-passing local Vitest suite (`server/drivers/claude.test.ts`, plus the new `fake-claude-cli.ts` mode) — this repo has a working local build and test runner (`pnpm`/`vitest`), unlike prior situations requiring standalone reproduction outside the repo.
- Run the full existing `server/drivers/claude.test.ts` file (not just the new tests) to confirm no regression in the broker/turn-lifecycle behavior the file already covers.
- Run `pnpm typecheck` (or the repo's documented type-check command) since this touches TypeScript control flow inside closures.

## Definition of Done

- [ ] `settle()` in `server/drivers/claude.ts` unconditionally calls `killCliTree(child)` on every terminal path (R1, R4).
- [ ] `createPermissionBroker`'s connection handler drops/denies any ask received after `close()` ran, and this cannot resurrect a `request.opened` card for a torn-down turn (R2).
- [ ] New `result-then-hang` fake-CLI mode added; new tests for both units pass.
- [ ] All pre-existing tests in `server/drivers/claude.test.ts` and `server/kill-tree.test.ts` still pass (R3).
- [ ] No changes to `codex.ts`, `acp/core.ts`, `antigravity.ts`, or the issue's point-3 startup sweep — explicitly deferred.
- [ ] Changes committed with a message referencing milind-soni/OpenMausBot#211.
