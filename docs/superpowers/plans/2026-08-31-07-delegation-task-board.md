# Delegation Task Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make delegated work visible and governable — a board with owners, status, and deadlines; handoffs that carry context and artifacts; a supervisor role that may delegate more than one hop; and concurrency and spend caps that make a deeper hierarchy safe to allow.

**Architecture:** `server/delegations.ts` already has the hard part — a crash-safe queue persisted to `delegations.json`, re-checked at drain time, with a depth cap that makes recursion structurally impossible. This plan does not replace it. It adds a durable work item alongside the queue entry, lifts the depth cap only for bots explicitly marked supervisors, and adds the two limits that make lifting it defensible.

**Tech Stack:** TypeScript, Node 24, Vitest, React.

**Spec:** none — this plan is its own spec.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints), plus one specific to this plan:

- **`MAX_COMMS_DEPTH = 1` stays the default.** `server/delegations.ts:29` explains what it buys: a peer receiving delegated work has no agents integration, so recursive delegation cannot happen at all. That property is why nobody has ever had to debug a runaway bot swarm in this codebase. It may be relaxed per-bot, never globally.

**Depends on:** [P1](2026-08-31-01-usage-accounting-and-budgets.md) for spend caps, [P2](2026-08-31-02-bot-profile.md) for the supervisor flag on the profile.

---

## Background

Two mechanisms exist and neither is visible as work. `ask_bot` is synchronous: A asks, B
answers inside A's turn. `delegate_bot` is asynchronous: A queues, and the item drains
after A's own turn settles, giving B a fresh depth-1 turn. `queueDelegation`
(`server/delegations.ts:116`) returns `"ok" | "no_target" | "self" | "too_deep" |
"too_many"`, and the exchange is mirrored into a channel by `comms-visibility.ts` so it
reads like a conversation.

Reading like a conversation is exactly the limitation. There is no board, no owner, no
status beyond queued-or-drained, no deadline, no artifact, and no reviewer. `TeamMapPage`
shows who talks to whom, not who owes what.

---

## File map

- Create `server/work-items.ts`: the durable work item — owner, status, deadline, artifacts, parent.
- Create `server/work-items.test.ts`.
- Modify `server/delegations.ts`: create a work item on queue; transition it on drain.
- Modify `server/delegations.test.ts`.
- Modify `server/store.ts`: `BotRecord.supervisor`, `BotRecord.maxConcurrentDelegations`.
- Modify `server/index.ts`: depth check reads the supervisor flag; board endpoints; concurrency and budget gates.
- Modify `server/index.test.ts`.
- Create `src/components/TaskBoard.tsx`, `src/components/TaskBoard.test.ts`.
- Modify `src/components/TeamMapPage.tsx`: a board tab beside the map.

---

### Task 1: The work item

**Files:**
- Create: `server/work-items.ts`, `server/work-items.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type WorkStatus = "queued" | "running" | "blocked" | "done" | "failed" | "cancelled";
  export interface WorkArtifact { kind: "file" | "url" | "thread"; ref: string; label?: string }
  export interface WorkItem {
    id: string; title: string; brief: string;
    fromBotId: string | null;          // null = the person asked
    ownerBotId: string; threadId?: string;
    parentId?: string; depth: number;
    status: WorkStatus; dueAt?: number;
    artifacts: WorkArtifact[];
    reviewerBotId?: string;
    createdAt: number; updatedAt: number;
  }
  export function createWorkItem(input: Omit<WorkItem, "id" | "status" | "artifacts" | "createdAt" | "updatedAt"> & { status?: WorkStatus }): WorkItem;
  export function transition(id: string, status: WorkStatus, patch?: Partial<Pick<WorkItem, "artifacts" | "threadId">>): WorkItem | { error: string };
  export function listWorkItems(filter?: { ownerBotId?: string; status?: WorkStatus[] }): WorkItem[];
  export function openCountFor(ownerBotId: string): number;
  ```

- [ ] Write failing tests: creating an item persists it and `listWorkItems` returns it; a filter by owner and by status set works; `openCountFor` counts `queued`, `running`, and `blocked` and excludes the three terminal states.
- [ ] Write a failing test that `transition` refuses a move out of a terminal state — a `done` item cannot go back to `running`. Terminal means terminal, or the board stops being a record of what happened.
- [ ] Write a failing test that the store survives a corrupt file: a truncated `work-items.json` loads as empty rather than throwing at boot, matching `_loadPending` in `server/delegations.ts:60`.
- [ ] Write a failing test that `brief` and artifact labels pass through `redactSecrets` — a brief is agent-authored.
- [ ] Run `pnpm vitest run server/work-items.test.ts`; expect FAIL.
- [ ] Implement over `DATA_DIR/work-items.json` with `writeFileAtomic` at `0600`.
- [ ] Run; expect PASS.
- [ ] Commit `feat(work): durable work items with owner, status, and artifacts`.

---

### Task 2: Delegations create work items

**Files:**
- Modify: `server/delegations.ts:116` (`queueDelegation`), `:150` (`drainDelegations`)
- Modify: `server/delegations.test.ts`

- [ ] Write a failing test: `queueDelegation` creates a `queued` work item whose `ownerBotId` is the target, `fromBotId` is the source, and `depth` matches the delegation's.
- [ ] Write a failing test: draining transitions the item to `running` and attaches the new thread id; a turn that settles successfully transitions it to `done`; a dispatch failure transitions it to `failed` with the reason.
- [ ] Write a failing test that a delegation discarded by `discardDelegations` (`server/delegations.ts:215`) transitions its item to `cancelled` rather than leaving it `queued` forever. A queue that empties without the board noticing is worse than no board.
- [ ] Write a failing test that a delegation refused at queue time (`"too_deep"`, `"too_many"`, `"self"`, `"no_target"`) creates **no** work item — the board records work, not rejected attempts.
- [ ] Run; expect FAIL.
- [ ] Implement. Keep the existing persistence and drain-time re-checks exactly as they are; the work item is a parallel record, not a replacement for the queue.
- [ ] Run `pnpm vitest run server/delegations.test.ts server/index.test.ts`; expect PASS.
- [ ] Commit `feat(work): delegations create and transition work items`.

---

### Task 3: The supervisor role and its two limits

**Files:**
- Modify: `server/store.ts` (`BotRecord`)
- Modify: `server/index.ts` (the depth check and the queue path)
- Test: `server/index.test.ts`

**Interfaces:**
- Produces: `BotRecord.supervisor?: boolean`, `BotRecord.maxConcurrentDelegations?: number` (default 3).

- [ ] Write a failing test that a non-supervisor bot at depth 1 still gets `"too_deep"` — the default is unchanged, and this is the test that guards the property the whole design rests on.
- [ ] Write a failing test that a bot marked `supervisor: true` may delegate at depth 1, producing a depth-2 item, and that depth 2 is refused regardless of the flag. One extra hop, not unlimited hops.
- [ ] Write a failing test that a supervisor with three open items is refused a fourth with `"too_many"`, and that completing one immediately admits the next.
- [ ] Write a failing test that a delegation which would exceed a P1 budget cap is refused at queue time with the budget error, not discovered at drain time. Discovering it at drain leaves an item stuck `queued` with no one to tell.
- [ ] Write a failing test that a supervisor loop — A delegates to B, B (also a supervisor) delegates back to A — terminates at the depth cap rather than ping-ponging. Assert on the total number of turns started, not just on the final state.
- [ ] Run; expect FAIL.
- [ ] Implement: the depth check consults the delegating bot's `supervisor` flag; the concurrency check calls `openCountFor`; the budget check reuses `evaluateBudget` from P1. Add `supervisor` and `maxConcurrentDelegations` to `BOT_PROFILE_PATCH_FIELDS` and to the P2 profile document under `autonomy`.
- [ ] Run `pnpm vitest run server/`; expect PASS.
- [ ] Commit `feat(work): supervisor role behind depth, concurrency, and budget caps`.

---

### Task 4: Structured handoff

**Files:**
- Modify: `server/drivers/agents-proxy.ts`, `server/drivers/agents-proxy.test.ts`
- Modify: `server/index.ts` (`/api/internal/delegate-bot` at `:2805`)

- [ ] Write a failing test that `delegate_bot` accepts optional `title`, `dueAt`, and `artifacts[]` alongside the existing `message` and `reason`, and that they land on the work item.
- [ ] Write a failing test that omitting all of them still works exactly as today — every existing caller and every existing test must keep passing unchanged.
- [ ] Write a failing test that an artifact `ref` pointing outside the delegating bot's workspace is refused. A handoff must not become a file-read primitive across bots.
- [ ] Write a failing test that the receiving bot's opening prompt includes the title, brief, artifacts, and deadline — a handoff that arrives as a bare message is the thing this task exists to fix.
- [ ] Run; expect FAIL.
- [ ] Implement, extending the tool schema and the internal route.
- [ ] Run; expect PASS.
- [ ] Commit `feat(work): structured handoffs with title, artifacts, and a deadline`.

---

### Task 5: Review stages

**Files:**
- Modify: `server/work-items.ts`, `server/work-items.test.ts`
- Modify: `server/index.ts`

- [ ] Write a failing test that an item with a `reviewerBotId` transitions to `blocked` rather than `done` when its turn settles, and queues a delegation to the reviewer carrying the original brief and the produced artifacts.
- [ ] Write a failing test that the reviewer's own completion transitions the **original** item to `done`, and that a reviewer cannot review its own work — a self-review is refused at set time with a clear error.
- [ ] Write a failing test that a review chain counts against the delegating supervisor's concurrency, so adding a reviewer cannot be used to route around the cap.
- [ ] Run; expect FAIL.
- [ ] Implement. Human approval stages already exist as a mechanism — `approvePeerComms` (`server/store.ts:339`) pauses a handoff for a person — so this task adds the bot-reviewer case only and should reuse `requestPeerApproval` rather than inventing a second gate.
- [ ] Run; expect PASS.
- [ ] Commit `feat(work): reviewer stage on a work item`.

---

### Task 6: The board

**Files:**
- Create: `src/components/TaskBoard.tsx`, `src/components/TaskBoard.test.ts`
- Modify: `src/components/TeamMapPage.tsx`
- Modify: `server/index.ts` (`GET /api/work-items`), `companion/src/routes.ts`

- [ ] Write a failing test for the pure grouping function: items group into `queued`, `running`, `blocked`, and a merged `finished` column; within a column, overdue items sort first, then by `dueAt`, then by `createdAt`.
- [ ] Write a failing test for the pure `overdueAt(item, now)` predicate: an item with no `dueAt` is never overdue; a terminal item is never overdue even if its `dueAt` has passed.
- [ ] Run; expect FAIL.
- [ ] Implement the board: four columns, each card showing owner avatar, title, who delegated it, deadline, artifact count, and reviewer. Clicking a card opens its thread.
- [ ] Add a delegation timeline view — who delegated what to whom, in order — from `parentId` and `createdAt`. This is the community's "timeline showing who delegated what to whom", and it is a rendering of data Task 1 already stores.
- [ ] Add `/api/work-items` to the companion allowlist as a read verb only, so the phone can see the board and cannot mutate it.
- [ ] Run the focused test, `pnpm typecheck`, `pnpm check:contrast`.
- [ ] Commit `feat(work): the delegation task board`.

---

## Self-review

**Coverage of the community's multi-agent list.** Shared task board — Tasks 1, 6.
Visible ownership, deadlines, status — Tasks 1, 6. Structured handoffs with context and
artifacts — Task 4. Supervisor and reviewer roles — Tasks 3, 5. Human approval stages —
already exist via `approvePeerComms`, reused in Task 5. Budgets and concurrency limits —
Task 3. Rules preventing endless bot-to-bot loops — Task 3, which keeps the existing
structural guarantee as the default and bounds the exception. Timeline — Task 6.

**Type consistency.** `WorkItem`, `WorkStatus`, and `WorkArtifact` (Task 1) are the only
types crossing into Tasks 2–6. `openCountFor` (Task 1) is consumed in Task 3.
`evaluateBudget` comes from P1 unchanged.

**The judgement call.** Task 3 permits exactly one extra hop for supervisors — depth 2,
never deeper. That is deliberately less than an org chart. The reason is in
`server/delegations.ts:29`: at depth 1 the receiving bot has **no agents integration at
all**, so recursion is impossible by construction rather than by counter. Every hop past
that replaces a structural guarantee with an arithmetic one, and arithmetic guarantees
fail under concurrency. One hop buys the coordinator-plus-worker-plus-reviewer shape
that covers most real delegation, and it can be widened later with evidence. Widening it
now, before the board exists to show what is actually happening, would be widening it
blind.
