# Parity Round 2 — Wakes, Triggers, Executors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the harness one general way to wake a settled bot, then put two
things on it: routines that fire from app events instead of only a clock, and
background executors that let a bot work on something while staying free to
talk.

**Architecture:** All three items are one seam — the connector-resume path at
`server/index.ts:2139–2196`, which is already a wake queue hardcoded to a
single trigger. Item 1 lifts it into `server/wakes.ts` with the dispatch policy
intact and the runtime injected (index.ts keeps `startTurn`,
`runGroupMemberTurn` and `groupQueues`). Items 2 and 3 then become wake
producers rather than new turn-dispatch paths.

**Tech Stack:** TypeScript (`--experimental-strip-types`), vitest, pnpm.
Tests: `pnpm vitest run <file>`; typecheck: `pnpm typecheck`.

**Spec:** `docs/plans/grok-parity-upgrades.md` — Round 2. Its *Working
agreement* section governs how this ships; read it before the last task.

## Global Constraints

- Everything in `docs/plans/grok-parity-upgrades.md` § Global Constraints applies unchanged.
- **Item 1 is a refactor of working code. Behavioural equivalence is the acceptance bar** — the existing connector-resume tests must pass untouched, and `dispatchConnectorResume` must end up a thin wake producer rather than a second implementation.
- A listener event is third-party text. It rides the same UNTRUSTED-DATA framing `server/webhooks.ts:320` already uses, and never reaches a prompt as instruction.
- An executor may not spawn an executor. Depth is capped exactly as `delegate_bot` is capped today.

---

## Task 1: The general wake queue

**Files:**
- Create: `server/wakes.ts`
- Create: `server/wakes.test.ts`
- Modify: `server/index.ts:2104-2196` (connector-resume becomes a producer)

**Interfaces:**
- Produces:
  - `type WakeSource = "connector" | "listener" | "executor"`
  - `interface Wake { key: string; source: WakeSource; botId: string; threadId: string; prompt: string; onFailure?: (message: string) => void }`
  - `interface WakeOwner { busy: boolean; groupId?: string }`
  - `interface WakeRuntime { owner(botId, threadId): WakeOwner | null; runGroupTurn(groupId: string, wake: Wake, requeue: () => void): void; runSoloTurn(wake: Wake): Promise<void> }`
  - `class WakeQueue { constructor(runtime: WakeRuntime); dispatch(wake: Wake): void; requeue(wake: Wake): void; drain(): void; readonly size: number }`

The dispatch policy, carried over verbatim from `dispatchConnectorResume`:

1. No owner (the bot/thread pairing is gone) → drop silently.
2. Owner busy → hold in `pending`, keyed by `wake.key`.
3. Owner is a group member → hand to `runGroupTurn`, which serializes on the
   group queue, re-checks busy inside the continuation, and calls `requeue`
   if the bot became busy while it waited.
4. Otherwise → `runSoloTurn`. A rejection whose message matches
   `/already working/i` re-queues; anything else is a real failure and goes to
   `wake.onFailure`.

`drain()` walks `pending`, skips wakes whose owner is still busy, and
re-dispatches the rest. It stays wired to the same `turn.completed`
subscriber that calls `drainConnectorResumes()` today.

- [ ] **Step 1: Write the failing test**

```ts
// server/wakes.test.ts
import { describe, expect, it, vi } from "vitest";

import { WakeQueue, type Wake, type WakeOwner, type WakeRuntime } from "./wakes.ts";

const wake = (over: Partial<Wake> = {}): Wake => ({
  key: "k1",
  source: "connector",
  botId: "bot-1",
  threadId: "t1",
  prompt: "carry on",
  ...over,
});

function harness(owner: WakeOwner | null, soloResult?: Promise<void>) {
  const runGroupTurn = vi.fn();
  const runSoloTurn = vi.fn(() => soloResult ?? Promise.resolve());
  const runtime: WakeRuntime = { owner: () => owner, runGroupTurn, runSoloTurn };
  return { queue: new WakeQueue(runtime), runGroupTurn, runSoloTurn };
}

describe("WakeQueue.dispatch", () => {
  it("runs a solo wake when the bot is idle", () => {
    const { queue, runSoloTurn } = harness({ busy: false });
    queue.dispatch(wake());
    expect(runSoloTurn).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
  });

  it("holds a wake for a busy bot instead of dropping or racing it", () => {
    const { queue, runSoloTurn } = harness({ busy: true });
    queue.dispatch(wake());
    expect(runSoloTurn).not.toHaveBeenCalled();
    expect(queue.size).toBe(1);
  });

  it("drops a wake whose bot/thread pairing is gone", () => {
    const { queue, runSoloTurn } = harness(null);
    queue.dispatch(wake());
    expect(runSoloTurn).not.toHaveBeenCalled();
    expect(queue.size).toBe(0);
  });

  it("routes a group member's wake through the group queue", () => {
    const { queue, runGroupTurn, runSoloTurn } = harness({ busy: false, groupId: "g1" });
    queue.dispatch(wake());
    expect(runGroupTurn).toHaveBeenCalledOnce();
    expect(runSoloTurn).not.toHaveBeenCalled();
  });

  it("dedupes by key — a second wake for the same pause replaces the first", () => {
    const { queue } = harness({ busy: true });
    queue.dispatch(wake({ prompt: "first" }));
    queue.dispatch(wake({ prompt: "second" }));
    expect(queue.size).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run server/wakes.test.ts`
Expected: FAIL — `Cannot find module './wakes.ts'`.

- [ ] **Step 3: Implement `WakeQueue`** (see the dispatch policy above; the
      code is written out in the executing session against these tests).

- [ ] **Step 4: Run the tests** — Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing async-outcome tests**

```ts
// append to server/wakes.test.ts
describe("WakeQueue solo failures", () => {
  it("re-queues when the turn says the bot is already working", async () => {
    const { queue } = harness({ busy: false }, Promise.reject(new Error("the bot is already working — interrupt it first")));
    queue.dispatch(wake());
    await new Promise((r) => setTimeout(r, 0));
    expect(queue.size).toBe(1);
  });

  it("reports a real failure instead of silently re-queueing forever", async () => {
    const onFailure = vi.fn();
    const { queue } = harness({ busy: false }, Promise.reject(new Error("no such bot")));
    queue.dispatch(wake({ onFailure }));
    await new Promise((r) => setTimeout(r, 0));
    expect(onFailure).toHaveBeenCalledWith("no such bot");
    expect(queue.size).toBe(0);
  });
});

describe("WakeQueue.drain", () => {
  it("dispatches held wakes once their bot is idle, and leaves the rest", () => {
    const busy = new Set(["bot-2"]);
    const runSoloTurn = vi.fn(() => Promise.resolve());
    const queue = new WakeQueue({
      owner: (botId) => ({ busy: busy.has(botId) }),
      runGroupTurn: vi.fn(),
      runSoloTurn,
    });
    busy.add("bot-1");
    queue.dispatch(wake({ key: "a", botId: "bot-1" }));
    queue.dispatch(wake({ key: "b", botId: "bot-2" }));
    expect(queue.size).toBe(2);
    busy.delete("bot-1");
    queue.drain();
    expect(runSoloTurn).toHaveBeenCalledOnce();
    expect(queue.size).toBe(1);
  });
});
```

- [ ] **Step 6: Run, implement, run** — Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add server/wakes.ts server/wakes.test.ts
git commit -m "feat(server): a general wake queue"
```

- [ ] **Step 8: Make connector-resume a producer**

In `server/index.ts`, replace `pendingConnectorResumes`,
`dispatchConnectorResume` and `drainConnectorResumes` with one `WakeQueue`
instance whose runtime is built from `connectorThread`, `groupQueues`,
`runGroupMemberTurn` and `startTurn`. `maybeResumeConnectors` then calls
`wakes.dispatch({...})` with `source: "connector"`, key
`` `${threadId}:${resumeKey}` ``, the same prompt string as today, and
`onFailure: (message) => markConnectorResumeFailed(threadId, resumeKey, message)`.
The `turn.completed` subscriber calls `wakes.drain()`.

**`connectorContinuation: true` must survive** — it is what keeps the resume
prompt from masquerading as a user message. Carry it on the solo path for
`source === "connector"`.

- [ ] **Step 9: Prove equivalence**

Run: `pnpm vitest run server/index.test.ts server/comms.test.ts server/delegations.test.ts`
Expected: PASS, with no test edited. If a connector test needed changing, the
refactor changed behaviour — back it out and find out why.

- [ ] **Step 10: Commit**

```bash
git add server/index.ts
git commit -m "refactor(server): connector resume becomes a wake producer"
```

---

## Task 2: Event-listener triggers

**Files:**
- Create: `server/triggers.ts`, `server/triggers.test.ts`
- Modify: `server/routines.ts` (a `RoutineTrigger` alongside `RoutineSchedule`)
- Modify: `server/webhook-ingress.ts` / `server/webhooks.ts` (normalize + match)
- Modify: `src/components/RoutinesPage.tsx` (pick a trigger)

**Interfaces:**
- `type EventListener = { type: "github"; repo: string; events: string[]; userAllowlist?: string[] } | { type: "slack"; channel: string; match: { kind: "message" | "mention" | "keyword"; keyword?: string } } | { type: "generic"; eventName: string }`
- `interface NormalizedEvent { source: string; kind: string; repo?: string; actor?: string; title?: string; channel?: string; text?: string; raw: unknown }`
- `normalizeWebhookEvent(headers: Record<string, string | undefined>, body: unknown): NormalizedEvent | null`
- `listenerMatches(listener: EventListener, event: NormalizedEvent): boolean`
- `buildEventContextBlock(event: NormalizedEvent): string` — the XML-tagged UNTRUSTED block

Matching is pure and table-tested: a GitHub `pr-opened` on the wrong repo does
not match; an allowlisted-author listener does not fire for a stranger; a
keyword listener is case-insensitive; an unknown source matches nothing.

Ingress change is thin: normalize → find enabled routines whose trigger
matches → `wakes.dispatch({ source: "listener", ... })` with the prompt built
from the routine's own text plus `buildEventContextBlock(event)`.

- [ ] **Step 1–6:** TDD the pure matcher first (it is the whole risk), then the
      ingress wiring, then the RoutinesPage control. Steps written in the
      executing session; the matcher table above is the spec.

---

## Task 3: Executor subagents — DEFERRED (2026-08-25)

**Not built. Deferred by Omkar after Tasks 1–2 shipped**, and it should not be
picked up without first answering the question that stopped it:

> An executor runs headless, so when it raises a permission request there is
> nobody to answer it. Three options, none obviously right: inherit the
> parent's `autoApprove` (safe only for bots already in auto mode), mirror the
> executor's cards into the parent's thread (visible, but the parent may be
> mid-turn), or fail closed and have the executor report that it was blocked
> (predictable, but cripples it for real work).

The design below is what was planned; it stands, minus that decision.

## Task 3 (original design): Executor subagents

**Files:**
- Create: `server/executors.ts`, `server/executors.test.ts`
- Modify: `server/drivers/agents-proxy.ts` (two tools)
- Modify: `server/index.ts` (two internal endpoints)

An executor is a **hidden clone of the parent bot** (`BotRecord.hidden`
already exists) running one task on its own thread, so no new concurrency
model is needed — the parent stays free to talk while it works. On the
executor's `turn.completed` the result becomes a wake to the parent.

- `run_executor(task, success_criteria)` → creates or reuses a hidden executor, dispatches, returns immediately
- `message_executor(executor_id, text)` → steers a running one rather than spawning a duplicate

Caps: **3 live executors per bot**, one task each, and `depth + 1` exactly as
`delegate_bot` computes it, so an executor gets no agents integration and
cannot spawn another.

- [ ] **Step 1–8:** TDD the roster/cap logic and the completion→wake path
      first; the tools are a thin shell over two internal endpoints.

---

## Task 4: Round 2 gate

- [ ] **Step 1:** `pnpm typecheck && pnpm test` green.
- [ ] **Step 2:** Compare `npx oxlint <file>` counts per touched file against `origin/main` — the repo's lint baseline is red, so the exit code proves nothing.
- [ ] **Step 3:** Build and launch the dev app per the working agreement.
- [ ] **Step 4:** Hand Omkar the Round 2 row of the what-to-exercise table and **stop**. Do not push. Do not open a PR. Do not start Round 3.
