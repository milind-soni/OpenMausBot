# Delegation Mailbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A queued bot-to-bot handoff waits for its target for up to 24 hours instead of giving up after three busy periods, and every surface a bot reads about its teammates tells "working" apart from "waiting on the user".

**Architecture:**
- Everything is server-side.
- `server/delegations.ts`:
  - A queued item carries `queuedAt` in place of the `attempts` counter.
  - `holdWhileTargetBusy()` waits without counting.
  - A 24-hour check in `processOne` expires stale items. The existing `onSettled → wakeUndispatchedDelegation` path then wakes the delegating bot.
  - An exported sweep, run hourly from `server/index.ts`, catches items nothing drains.
- `server/peer-roster.ts` gains one `peerStatus()` mapping from the harness's existing `BotActivity`. The roster, `list_bots`, handoff chips and `check_delegation` all read that one mapping.

**Tech Stack:** TypeScript (strict), Node, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-12-delegation-mailbox-design.md`

**Deviations from the spec**

Each of these was found while reading the code for this plan:

1. **`/api/internal/agents` also returns `statusText`,** the server's own wording. The agents proxy runs as a separate process and would otherwise need a second copy of the wording table.
2. **The unavailable wording is `unavailable — needs setup`,** not `unavailable (needs setup)`. The roster already wraps the wording in parentheses, so the spec's version would print nested parentheses.
3. **`pendingDelegationInfo` also returns `waiting: boolean`.** Existing tests synchronise on "the item is parked on a busy target", which they currently read from `attempts`.
4. **There is no separate boot sweep; the hourly sweep starts after the boot drain.**
   - The existing boot loop drains every leftover thread, and a drain now expires stale items itself.
   - A sweep placed *before* that loop would wake delegators of stopped routine runs, whose handoffs the loop is about to discard.
5. **The agents proxy's `check_delegation` rendering prints the new queued fields.** The spec added them to the endpoint but did not name the proxy, and without this the model never sees them.
6. **`peerStatus` takes `(activity, busy)`, not the single-argument `peerStatus(activity)` the spec described.** A record without an `activity` — or still `idle` while `busy` is set, as older callers and test fixtures write it — falls back to `busy`, so anything that only knew `busy` before this change still reads exactly as it did.
7. **`expireDelegation` takes an `ownerId` and posts no chip into a thread the delegator no longer owns.** A source thread can outlive the bot that queued the handoff (deletion, reassignment); the receipt is still recorded, but the chip only goes into a thread the current owner can actually see.
8. **The expiry check sits after the source-ownership check rather than strictly at the top of `processOne`** (and, after the final-review fix for the boot-drain regression, after the `dropIfUnreachable`/`dropIfThreadGone` reachability gates too). Ownership is checked first because an orphaned source thread should report "dropped", not "expired"; the reachability gates now run before expiry so a handoff whose target is free right now — including one whose downtime spans an app restart or laptop sleep — is delivered instead of expired.

## Global Constraints

- Work only in the worktree `~/Desktop/openmaus/OpenGrokBot-mailbox`, on branch `feat/delegation-mailbox`. Never touch `~/Desktop/openmaus/OpenGrokBot`.
- Commit locally after each task. **Never push. Never open a PR.** Omkar owns publishing.
- End every commit message with: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Server-only change. No edits under `src/`, `ios/`, `android/`.
- No new persisted file. `delegations.json` gains one numeric field per item. Receipts stay bounded by `MAX_RECEIPTS` / `RECEIPT_MAX_AGE_MS`.
- `DELEGATION_TTL_MS = 24 * 60 * 60 * 1000`.
- `MAX_QUEUED_PER_THREAD = 4` and `MAX_COMMS_DEPTH = 1` are unchanged.
- Run one test file with `pnpm vitest run <path>`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`.
- Baseline before Task 1: `server/delegations.test.ts`, `server/peer-roster.test.ts`, `server/chief-of-staff.test.ts` and `server/drivers/agents-proxy.test.ts` together pass 143 tests.

---

### Task 1: `peerStatus` and truthful roster wording

**Files:**
- Modify: `server/peer-roster.ts` (top of file, `RosterMember`, `renderRoster`)
- Test: `server/peer-roster.test.ts`

**Interfaces:**
- Produces:
  - `export type PeerStatus = "available" | "working" | "waiting-on-user" | "not-responding" | "unavailable"`
  - `export function peerStatus(activity: BotActivity | undefined, busy: boolean | undefined): PeerStatus`
  - `export function peerStatusWords(status: PeerStatus): string`
  - `RosterMember.activity?: BotActivity`

- [ ] **Step 1: Write the failing tests**

In `server/peer-roster.test.ts`, add `peerStatus,` to the import list from `./peer-roster.ts` (after `peerRosterSystemPrompt,`). Then append:

```ts
describe("peerStatus", () => {
  it("reads the harness activity, not just busy", () => {
    expect(peerStatus("idle", false)).toBe("available");
    expect(peerStatus(undefined, false)).toBe("available");
    expect(peerStatus("working", true)).toBe("working");
    expect(peerStatus("waiting-on-you", true)).toBe("waiting-on-user");
    expect(peerStatus("no-signal", true)).toBe("not-responding");
    expect(peerStatus("dead", false)).toBe("unavailable");
  });

  it("falls back to busy when there is no activity signal", () => {
    // fixtures and older callers set busy without activity
    expect(peerStatus(undefined, true)).toBe("working");
    expect(peerStatus("idle", true)).toBe("working");
  });
});

describe("renderRoster status wording", () => {
  it("tells a teammate waiting on the user apart from one that is working", () => {
    const prompt = peerRosterSystemPrompt([
      { id: "a", name: "Patch", title: "Engineer", activity: "working", busy: true },
      { id: "b", name: "Quill", title: "Writer", activity: "waiting-on-you", busy: true },
      { id: "c", name: "Scout", title: "Planner", activity: "no-signal", busy: true },
      { id: "d", name: "Ghost", title: "Archivist", activity: "dead" },
    ]);
    expect(prompt).toContain("- Patch — Engineer (working right now)");
    expect(prompt).toContain("- Quill — Writer (waiting on the user)");
    expect(prompt).toContain("- Scout — Planner (not responding)");
    expect(prompt).toContain("- Ghost — Archivist (unavailable — needs setup)");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run server/peer-roster.test.ts`
Expected: FAIL — `peerStatus` is not exported. The roster test fails because Quill renders "(working right now)".

- [ ] **Step 3: Implement**

At the top of `server/peer-roster.ts`, after the header comment:

```ts
import type { BotActivity } from "./store.ts";
```

Add to `RosterMember`, after `busy?: boolean;`:

```ts
  /** What the harness last saw the bot doing. `busy` alone cannot tell a
   * bot mid-task from one parked on the user's approval card. */
  activity?: BotActivity;
```

Add after the `sectionKey` const:

```ts
export type PeerStatus = "available" | "working" | "waiting-on-user" | "not-responding" | "unavailable";

const PEER_STATUS_WORDS: Record<PeerStatus, string> = {
  available: "available",
  working: "working right now",
  "waiting-on-user": "waiting on the user",
  "not-responding": "not responding",
  unavailable: "unavailable — needs setup",
};

/** What a teammate is doing, as another bot should read it. `activity` is
 * the harness's own signal. A record without one — or still `idle` while
 * `busy` is set, as older callers and test fixtures write it — falls back
 * to `busy`, so anything that only knows busy reads exactly as before. */
export function peerStatus(activity: BotActivity | undefined, busy: boolean | undefined): PeerStatus {
  switch (activity) {
    case "working":
      return "working";
    case "waiting-on-you":
      return "waiting-on-user";
    case "no-signal":
      return "not-responding";
    case "dead":
      return "unavailable";
    default:
      return busy ? "working" : "available";
  }
}

export function peerStatusWords(status: PeerStatus): string {
  return PEER_STATUS_WORDS[status];
}
```

In `renderRoster`, replace:

```ts
    const availability = bot.busy ? "working right now" : "available";
```

with:

```ts
    const availability = peerStatusWords(peerStatus(bot.activity, bot.busy));
```

- [ ] **Step 4: Run the tests, including the Chief's roster**

Run: `pnpm vitest run server/peer-roster.test.ts server/chief-of-staff.test.ts`
Expected: PASS. The Chief fixtures use `busy: true` without `activity` and still read "(working right now)".

- [ ] **Step 5: Commit**

```bash
git add server/peer-roster.ts server/peer-roster.test.ts
git commit -m "feat(peers): roster says when a teammate is waiting on the user

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `list_bots` reports what each teammate is doing

**Files:**
- Modify: `server/index.ts:85` (peer-roster import) and the `GET /api/internal/agents` handler (search `path === "/api/internal/agents"`)
- Modify: `server/drivers/agents-proxy.ts` — the `list_bots` tool description and the `list_bots` branch of `callTool`
- Test: `server/drivers/agents-proxy.test.ts`

**Interfaces:**
- Consumes: `peerStatus`, `peerStatusWords` (Task 1).
- Produces: `/api/internal/agents` rows gain `status: PeerStatus` and `statusText: string`. `busy` is unchanged.

- [ ] **Step 1: Make the agents stub configurable, and write the failing test**

In `server/drivers/agents-proxy.test.ts`, next to the other `let …Response` declarations (around line 23), add:

```ts
const DEFAULT_AGENTS = { bots: [{ id: "bot-helper", name: "Helper", model: "fake-model", busy: false }] };
let agentsResponse: unknown = DEFAULT_AGENTS;
```

In the stub's `/api/internal/agents` branch, replace:

```ts
        JSON.stringify({
          bots: [{ id: "bot-helper", name: "Helper", model: "fake-model", busy: false }],
        }),
```

with:

```ts
        JSON.stringify(agentsResponse),
```

Add after the test `"list_bots renders the roster and authenticates with the shared token"`:

```ts
  it("list_bots says what each teammate is doing, not just busy", async () => {
    agentsResponse = {
      bots: [
        { id: "bot-helper", name: "Helper", model: "fake-model", busy: true, status: "waiting-on-user", statusText: "waiting on the user" },
        { id: "bot-quill", name: "Quill", model: "fake-model", busy: false, status: "available", statusText: "available" },
        { id: "bot-old", name: "Old", model: "fake-model", busy: true },
      ],
    };
    try {
      const text = (await callTool("list_bots", {})).result.content[0].text;
      expect(text).toContain("[id: bot-helper, model: fake-model, waiting on the user]");
      expect(text).toContain("[id: bot-quill, model: fake-model]");
      // an older server that only sends busy still reads as before
      expect(text).toContain("[id: bot-old, model: fake-model, busy]");
    } finally {
      agentsResponse = DEFAULT_AGENTS;
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run server/drivers/agents-proxy.test.ts -t "what each teammate is doing"`
Expected: FAIL — Helper renders `, busy`, not `, waiting on the user`.

- [ ] **Step 3: Implement the proxy side**

In `server/drivers/agents-proxy.ts`, in the `list_bots` branch of `callTool`, replace:

```ts
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${b.busy ? ", busy" : ""}]`;
```

with:

```ts
      // statusText is the server's own wording for what the teammate is
      // doing; an older server only sends busy, so fall back to that.
      const state = typeof b.statusText === "string"
        ? (b.status === "available" ? "" : b.statusText)
        : (b.busy ? "busy" : "");
      return `- ${b.name}${role}${about} [id: ${b.id}, model: ${b.model}${state ? `, ${state}` : ""}]`;
```

In the `list_bots` tool definition, change the description's opening sentence from:

```
"List the other bots (agents) in your OpenMausBot section, with their model and whether they're busy.
```

to:

```
"List the other bots (agents) in your OpenMausBot section, with their model and what each is doing right now (available, working, waiting on the user, not responding, or unavailable).
```

Leave the rest of that description string unchanged.

- [ ] **Step 4: Implement the server side**

In `server/index.ts` line 85, add `peerStatus, peerStatusWords,` to the import from `./peer-roster.ts`:

```ts
import { peerAllowed, peerName, peerRosterSystemPrompt, peerStatus, peerStatusWords, reachablePeers, roomPeerRosterSystemPrompt, roomRosterLine } from "./peer-roster.ts";
```

In the `GET /api/internal/agents` handler, replace the `.map((b) => ({ … }))` with:

```ts
          .map((b) => {
            const status = peerStatus(b.activity, b.busy);
            return {
              id: b.id,
              name: b.name,
              model: b.modelSelection.model,
              busy: !!b.busy,
              status,
              statusText: peerStatusWords(status),
              title: b.title || undefined,
              description: b.description || undefined,
            };
          });
```

- [ ] **Step 5: Run the tests and check nothing pinned the old description**

Run: `pnpm vitest run server/drivers/agents-proxy.test.ts && grep -rn "whether they're busy" server src`
Expected: tests PASS; grep prints nothing.

- [ ] **Step 6: Commit**

```bash
git add server/index.ts server/drivers/agents-proxy.ts server/drivers/agents-proxy.test.ts
git commit -m "feat(peers): list_bots reports what each teammate is doing

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Handoffs wait for a busy target without counting

**Files:**
- Modify: `server/delegations.ts`
  - `PendingDelegationItem`
  - `DelegationOutcome`
  - `MAX_BUSY_ATTEMPTS`
  - `pendingDelegationInfo`
  - `_loadPending`
  - `queueDelegation`
  - the `drainDelegations` redrain comment
  - `holdWhileTargetBusy`
- Test: `server/delegations.test.ts`

**Interfaces:**
- Produces:
  - `PendingDelegationItem.queuedAt: number`
  - `PendingDelegationItem.waitAnnounced?: boolean`
  - `DelegationOutcome` includes `"expired"`
  - `pendingDelegationInfo(id): { sourceThreadId: string; toBotId: string; queuedAt: number; waiting: boolean } | null`
- Removes: `MAX_BUSY_ATTEMPTS` and `PendingDelegationItem.attempts`.

- [ ] **Step 1: Update the existing tests to the new behaviour**

In `server/delegations.test.ts`:

1. Top import from `./delegations.ts`: delete the line `MAX_BUSY_ATTEMPTS,`.
2. In `"keeps the handoff queued with a 'waiting' chip when the target is currently busy"`, replace the expectation:
   ```ts
   expect(chip.tool?.name).toBe("Delegation to @Helper waiting — they're busy; it'll go through when they're free");
   ```
3. In `"retains an exact approval when the target becomes busy before dispatch"` and in the `it.each` test `"drops an approved busy retry after %s"`, replace each
   ```ts
   await waitFor(() => pendingDelegationInfo(queued.id!)?.attempts === 1);
   ```
   with
   ```ts
   await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
   ```
4. In `describe("delegations survive a restart")`, test `"writes the queue to disk on queue, and clears it on drain and discard"`, extend the `toMatchObject` on `onDisk[from.threadId][0]` with `queuedAt: expect.any(Number),`.
5. Rename `describe("busy retries and receipts", …)` to `describe("busy waits and expiry", …)`.
6. In that describe, in `"keeps a handoff queued while the target is busy and dispatches on the retry drain"`:
   - Replace `await waitFor(() => chipCount("waiting — they're busy (retry 1/") === 1);` with `await waitFor(() => chipCount("waiting — they're busy;") === 1);`
   - Replace `expect(pendingDelegationInfo(taskId)).toMatchObject({ toBotId: target.id, attempts: 1 });` with `expect(pendingDelegationInfo(taskId)).toMatchObject({ toBotId: target.id, waiting: true });`
7. Delete the tests `"gives up after the bounded retries, with a receipt the delegator can read"` and `"does not burn busy retries when an unrelated drain is requested"`. In their place, add:

```ts
  it("waits through any number of busy periods and still delivers", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const runTarget = vi.fn();
    for (let period = 0; period < 5; period++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
      // the target's turn settles, and another turn claims it straight away
      expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    }
    expect(findDelegationReceipt(queued.id!)).toBeNull();
    expect(chipCount("waiting — they're busy;")).toBe(1);

    store.patchBot(target.id, { busy: false });
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
    expect(_pendingCount(from.threadId)).toBe(0);
  });

  it("posts one waiting chip per handoff, however many drains run while the target is busy", async () => {
    store.patchBot(target.id, { busy: true });
    const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    const runTarget = vi.fn();

    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => chipCount("waiting — they're busy;") === 1);
    // A source-thread redrain can happen while an approval for another item
    // settles. It must not re-announce the same wait.
    for (let index = 0; index < 4; index++) {
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(chipCount("waiting — they're busy;")).toBe(1);
    expect(pendingDelegationInfo(queued.id!)).toMatchObject({ waiting: true });

    store.patchBot(target.id, { busy: false });
    expect(releaseDelegationsWaitingOn(target.id)).toEqual([from.threadId]);
    drainDelegations(commsBus, approvalBus, from.threadId, runTarget);
    await waitFor(() => runTarget.mock.calls.length === 1);
  });

  it("says the target is waiting on you when it is parked on an approval", async () => {
    store.patchBot(target.id, { busy: true, activity: "waiting-on-you" });
    queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
    drainDelegations(commsBus, approvalBus, from.threadId, vi.fn());
    await waitFor(() => chipCount("who's waiting on you") === 1);
    expect(chipCount("Waiting for @Helper, who's waiting on you — it'll go through after you answer")).toBe(1);
    expect(chipCount("they're busy")).toBe(0);
  });
```

8. In `describe("delegations survive a restart")`, add:

```ts
  it("gives a handoff saved before queuedAt existed a fresh 24-hour window", () => {
    const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(file(), JSON.stringify({
      [from.threadId]: [
        { id: "legacy-1", sourceBotId: from.id, toBotId: target.id, message: "old", depth: 0, attempts: 2 },
      ],
    }));
    const before = Date.now();
    _loadPending();
    expect(pendingDelegationInfo("legacy-1")?.queuedAt).toBeGreaterThanOrEqual(before);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run server/delegations.test.ts`
Expected: FAIL. The chip text still has `(retry 1/3 …)`, `waiting` / `queuedAt` are undefined, and the waiting-on-you chip is missing.

- [ ] **Step 3: Implement the data changes**

In `server/delegations.ts`, in `interface PendingDelegationItem`, replace the `attempts` field and its doc comment with:

```ts
  /** When this handoff was queued (epoch ms). It waits for a busy target
   * for up to DELEGATION_TTL_MS from here, then expires with a receipt. */
  queuedAt: number;
  /** This handoff has already posted its "waiting" chip. One chip per
   * handoff, not one per busy period. */
  waitAnnounced?: boolean;
```

Replace the doc comment on `waitingOnBusy` with:

```ts
  /** Parked on the target's current busy period. The target's idle
   * transition (releaseDelegationsWaitingOn) clears it and re-drains the
   * source thread; nothing else counts or retries. */
```

Change the outcome type to:

```ts
/** `busy_gave_up` is only read back from receipts written before handoffs
 * stopped counting busy periods; nothing produces it any more. */
export type DelegationOutcome = "done" | "failed" | "denied" | "expired" | "busy_gave_up" | "dropped" | "error";
```

Delete the line `export const MAX_BUSY_ATTEMPTS = 3;`.

Replace `pendingDelegationInfo` with:

```ts
/** A still-queued task's routing info, or null once it dispatched/settled. */
export function pendingDelegationInfo(
  id: string,
): { sourceThreadId: string; toBotId: string; queuedAt: number; waiting: boolean } | null {
  for (const [sourceThreadId, items] of pendingDelegations) {
    const item = items.find((candidate) => candidate.id === id);
    if (item) return { sourceThreadId, toBotId: item.toBotId, queuedAt: item.queuedAt, waiting: item.waitingOnBusy === true };
  }
  return null;
}
```

In `_loadPending`, in the `loaded` object, replace the line:

```ts
          attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.trunc(item.attempts!)) : 0,
```

with:

```ts
          // saved before queuedAt existed: start its 24 hours now, so an
          // upgrade never expires queued work on the spot
          queuedAt: Number.isFinite(item.queuedAt) ? item.queuedAt! : Date.now(),
```

Also in `_loadPending`, after `if (item.waitingOnBusy === true) loaded.waitingOnBusy = true;`, add:

```ts
        if (item.waitAnnounced === true) loaded.waitAnnounced = true;
```

In `queueDelegation`, replace:

```ts
  list.push({ ...item, id, sourceBotId: from.id, attempts: 0, ...(groupId ? { originatingGroupId: groupId } : {}) });
```

with:

```ts
  list.push({ ...item, id, sourceBotId: from.id, queuedAt: Date.now(), ...(groupId ? { originatingGroupId: groupId } : {}) });
```

In `drainDelegations`' `.finally`, replace the comment lines:

```ts
    // drain — re-draining a just-requeued item would burn its bounded busy
    // retries in milliseconds instead of once per target settle.
```

with:

```ts
    // drain — re-draining a just-requeued item would spin it in a tight
    // loop instead of once per target settle.
```

- [ ] **Step 4: Replace `holdWhileTargetBusy`**

Replace the whole function *and* its doc comment. That runs from `/** A busy target holds the handoff.` down to the `}` that closes the function, just before `/** The thread a fresh-thread handoff was opened in may be deleted`. Replace it with:

```ts
/** A busy target holds the handoff. What "busy" means depends on where the
 * turn will run: a classic delegation lands in the target's active thread,
 * so it waits for the bot to go idle; a fresh-thread handoff needs only a
 * free slot. Neither counts busy periods — the only bound is
 * DELEGATION_TTL_MS, checked in processOne before this runs. One waiting
 * chip per handoff, worded for what the target is actually doing. Returns
 * null when the target can take the turn now. */
function holdWhileTargetBusy(
  bus: CommsBus,
  target: BotRecord,
  sourceThreadId: string,
  item: PendingDelegationItem,
): "requeued" | null {
  const free = item.targetThreadId
    ? (bus.threadSlotFree ? bus.threadSlotFree(target.id) : !target.busy)
    : !target.busy;
  if (free) return null;
  if (item.waitingOnBusy) return "requeued";
  item.waitingOnBusy = true;
  if (!item.waitAnnounced) {
    item.waitAnnounced = true;
    bus.store.appendMessage(sourceThreadId, {
      role: "bot",
      kind: "activity",
      tool: { name: waitingChipText(bus.store, target, item) },
    });
  }
  savePending();
  return "requeued";
}

function waitingChipText(store: Store, target: BotRecord, item: PendingDelegationItem): string {
  if (item.targetThreadId) {
    const title = store.taskByThread(target.id, item.targetThreadId)?.title ?? "thread";
    return `Thread #${title} on @${target.name} waiting for a free slot`;
  }
  if (target.activity === "waiting-on-you") {
    return `Waiting for @${target.name}, who's waiting on you — it'll go through after you answer`;
  }
  return `Delegation to @${target.name} waiting — they're busy; it'll go through when they're free`;
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run server/delegations.test.ts server/routines-startup.test.ts`
Expected: PASS. `routines-startup` writes legacy `attempts: 0` items, and the loader now ignores that field.

Run: `grep -n "MAX_BUSY_ATTEMPTS\|attempts" server/delegations.ts server/delegations.test.ts`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add server/delegations.ts server/delegations.test.ts
git commit -m "feat(delegations): wait for a busy target instead of giving up after 3 busy periods

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: 24-hour expiry and the sweep

**Files:**
- Modify: `server/delegations.ts`
  - new constants and helpers near `recordDelegationReceipt`
  - `processOne`, right after its first (source-ownership) check
  - new export `expireStaleDelegations`
- Test: `server/delegations.test.ts`

**Interfaces:**
- Consumes: `PendingDelegationItem.queuedAt`, `"expired"` (Task 3).
- Produces:
  - `export const DELEGATION_TTL_MS: number`
  - `export function expireStaleDelegations(bus: CommsBus, now: number, onSettled?: (receipt: DelegationReceipt) => void): number` — returns how many handoffs it expired.

- [ ] **Step 1: Write the failing tests**

In `server/delegations.test.ts`, add `DELEGATION_TTL_MS,` and `expireStaleDelegations,` to the top import list from `./delegations.ts`.

In `describe("busy waits and expiry")`, add:

```ts
  it("expires a handoff nobody could take within 24 hours, and wakes the delegator", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(target.id, { busy: true });
      const queued = queueDelegation(commsBus, from, { toBotId: target.id, message: "later", depth: 0 }, 1);
      const runTarget = vi.fn();
      const settled: string[] = [];
      const onSettled = (receipt: { status: string }) => void settled.push(receipt.status);

      drainDelegations(commsBus, approvalBus, from.threadId, runTarget, onSettled);
      await waitFor(() => pendingDelegationInfo(queued.id!)?.waiting === true);
      releaseDelegationsWaitingOn(target.id);

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      drainDelegations(commsBus, approvalBus, from.threadId, runTarget, onSettled);
      await waitFor(() => _pendingCount(from.threadId) === 0);

      expect(runTarget).not.toHaveBeenCalled();
      expect(findDelegationReceipt(queued.id!)).toMatchObject({
        status: "expired",
        toBotName: "Helper",
        result: "@Helper was not free to take this for 24 hours",
      });
      expect(chipCount("Delegation to @Helper expired — not picked up within 24 hours")).toBe(1);
      expect(settled).toEqual(["expired"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires a fresh-thread handoff that never gets a free slot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slotBus: CommsBus = { ...commsBus, threadSlotFree: () => false };
      const opened = store.createTask(target.id, "QA", false)!;
      const queued = queueDelegation(
        slotBus,
        from,
        { toBotId: target.id, message: "check", depth: 0, targetThreadId: opened.threadId },
        1,
      );
      const runTarget = vi.fn();
      drainDelegations(slotBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => chipCount("waiting for a free slot") === 1);
      releaseDelegationsWaitingOn(target.id);

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      drainDelegations(slotBus, approvalBus, from.threadId, runTarget);
      await waitFor(() => _pendingCount(from.threadId) === 0);

      expect(runTarget).not.toHaveBeenCalled();
      expect(findDelegationReceipt(queued.id!)).toMatchObject({ status: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });
```

In `describe("delegations survive a restart")`, add:

```ts
  it("expireStaleDelegations expires due handoffs across threads, keeps fresh ones, and reports each once", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const other = store.createTask(from.id, "Other", false)!.threadId;
      const stale = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "stale", depth: 0 }, 1);
      const staleOther = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "stale too", depth: 0 }, 1, other);
      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS - 1));
      const fresh = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "fresh", depth: 0 }, 1);
      vi.setSystemTime(new Date(Date.now() + 1));

      const settled: string[] = [];
      expect(expireStaleDelegations(buses.commsBus, Date.now(), (receipt) => void settled.push(receipt.id))).toBe(2);
      expect(settled.sort()).toEqual([stale.id!, staleOther.id!].sort());
      expect(findDelegationReceipt(stale.id!)).toMatchObject({ status: "expired" });
      expect(pendingDelegationInfo(fresh.id!)).not.toBeNull();
      expect(JSON.parse(readFileSync(file(), "utf8"))[other]).toBeUndefined();
      // nothing left to do on a second pass
      expect(expireStaleDelegations(buses.commsBus, Date.now())).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expireStaleDelegations leaves a thread mid-drain to the drain that owns it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      store.patchBot(from.id, { approvePeerComms: true });
      const queued = queueDelegation(buses.commsBus, from, { toBotId: target.id, message: "held", depth: 0 }, 1);
      drainDelegations(buses.commsBus, buses.approvalBus, from.threadId, vi.fn());
      // the drain is now parked on the approval card
      const card = await waitFor(() => store.messagesFor(from.threadId).find((m) => m.card?.requestId));

      vi.setSystemTime(new Date(Date.now() + DELEGATION_TTL_MS));
      expect(expireStaleDelegations(buses.commsBus, Date.now())).toBe(0);
      expect(pendingDelegationInfo(queued.id!)).not.toBeNull();

      resolvePeerComms(buses.approvalBus, card.card!.requestId!, "deny");
      await waitFor(() => pendingThreads().length === 0);
    } finally {
      vi.useRealTimers();
    }
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run server/delegations.test.ts -t "expire"`
Expected: FAIL — `DELEGATION_TTL_MS` and `expireStaleDelegations` are not exported, and the busy handoff never expires.

- [ ] **Step 3: Implement the expiry helpers**

In `server/delegations.ts`, after `const RESULT_MAX_CHARS = 4_000;`, add:

```ts
/** How long a queued handoff may wait for its target before it expires.
 * A busy target is waited for through any number of its own turns; only
 * this bounds the wait, so a handoff to a bot nobody uses cannot hold one
 * of its source thread's MAX_QUEUED_PER_THREAD slots forever. */
export const DELEGATION_TTL_MS = 24 * 60 * 60 * 1000;
```

After `function acknowledgeDelegation(…) { … }`, add:

```ts
const isExpired = (item: PendingDelegationItem, now: number): boolean => now - item.queuedAt >= DELEGATION_TTL_MS;

/** Record an expired handoff. The chip goes into the source thread only
 * while it still belongs to the bot that owns the handoff — a deleted
 * conversation gets the receipt and nothing else. */
function expireDelegation(bus: CommsBus, sourceThreadId: string, item: PendingDelegationItem, ownerId: string): void {
  const name = bus.store.bot(item.toBotId)?.name ?? item.toBotId;
  recordDelegationReceipt({
    id: item.id,
    sourceThreadId,
    toBotId: item.toBotId,
    toBotName: name,
    status: "expired",
    result: `@${name} was not free to take this for 24 hours`,
  });
  if (!sourceThreadBelongsToBot(bus.store, ownerId, sourceThreadId)) return;
  bus.store.appendMessage(sourceThreadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `Delegation to @${name} expired — not picked up within 24 hours`, ok: false },
  });
}

/** Expire every queued handoff past DELEGATION_TTL_MS, wherever it waits.
 * A drain already expires what it touches; this covers the handoff nothing
 * drains — a target that never settles while its source sits idle. A
 * thread mid-drain is skipped: that drain owns its items and expires them
 * itself. Each expiry is reported through `onSettled`, the same hook a
 * drain uses to wake the delegating bot. Returns how many expired. */
export function expireStaleDelegations(
  bus: CommsBus,
  now: number,
  onSettled?: (receipt: DelegationReceipt) => void,
): number {
  const expired: DelegationReceipt[] = [];
  for (const [threadId, items] of [...pendingDelegations]) {
    if (drainingThreads.has(threadId)) continue;
    const due = items.filter((item) => isExpired(item, now));
    if (!due.length) continue;
    const remaining = items.filter((item) => !isExpired(item, now));
    if (remaining.length) pendingDelegations.set(threadId, remaining);
    else pendingDelegations.delete(threadId);
    const ownerId = bus.store.botByThread(threadId)?.id;
    for (const item of due) {
      expireDelegation(bus, threadId, item, ownerId ?? item.sourceBotId);
      const receipt = findDelegationReceipt(item.id);
      if (receipt) expired.push(receipt);
    }
  }
  if (!expired.length) return 0;
  savePending();
  for (const receipt of expired) {
    try {
      onSettled?.(receipt);
    } catch (error) {
      console.error("delegation expired but its source could not be resumed", error);
    }
  }
  return expired.length;
}
```

- [ ] **Step 4: Check expiry in `processOne`**

In `processOne`, directly after the first `if (!sourceThreadBelongsToBot(bus.store, sender.id, sourceThreadId)) { … return "settled"; }` block, and before `if (!target) {`, add:

```ts
  // Past its 24 hours: the only bound on how long a handoff waits. Checked
  // first so no later branch — busy, approval, dispatch — can act on it.
  if (isExpired(item, Date.now())) {
    expireDelegation(bus, sourceThreadId, item, sender.id);
    return "settled";
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run server/delegations.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/delegations.ts server/delegations.test.ts
git commit -m "feat(delegations): expire a queued handoff after 24 hours

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire expiry and queued status into the server and proxy

**Files:**
- Modify: `server/index.ts`
  - the delegations import (line ~180)
  - after `function drainThreadDelegations`
  - the `server.listen` callback, after the leftover-drain loop
  - the `check_delegation` queued branch (search `status: "queued",`)
  - the `ask_bot` fallback comment (search `bounded busy`)
- Modify: `server/drivers/agents-proxy.ts` — the `r.status === "queued"` branch in the `check_delegation`/`wait_delegation` handler
- Test: `server/drivers/agents-proxy.test.ts`

**Interfaces:**
- Consumes:
  - `DELEGATION_TTL_MS`, `expireStaleDelegations` (Task 4)
  - `pendingDelegationInfo(...).queuedAt` (Task 3)
  - `peerStatus` (Task 1)
- Produces: the queued `check_delegation` response gains `targetStatus: PeerStatus` and `expiresInMs: number`.

- [ ] **Step 1: Write the failing proxy test**

In `server/drivers/agents-proxy.test.ts`, add after the test containing `"still queued"`:

```ts
  it("check_delegation explains a queued handoff: who it is waiting on, and when it expires", async () => {
    delegationStatusResponse = {
      status: "queued",
      toBotName: "Helper",
      targetStatus: "waiting-on-user",
      expiresInMs: 5 * 3_600_000 - 1,
    };
    try {
      const text = (await callTool("check_delegation", { task_id: "task-later456" })).result.content[0].text;
      expect(text).toContain("still queued");
      expect(text).toContain("@Helper is waiting on the user, so it goes through after they answer.");
      expect(text).toContain("It expires if not picked up within 5 hours.");
    } finally {
      delegationStatusResponse = { status: "done", toBotName: "Helper", result: "All done." };
    }
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run server/drivers/agents-proxy.test.ts -t "explains a queued handoff"`
Expected: FAIL — the text has neither the waiting-on line nor the expiry line.

- [ ] **Step 3: Implement the proxy rendering**

In `server/drivers/agents-proxy.ts`, replace:

```ts
    if (r.status === "queued") {
      return { text: `Task ${taskId} is still queued — ${who} hasn't picked it up yet${waitMs ? ` after ${timeout}s` : ""}. Keep working and check again later.` };
    }
```

with:

```ts
    if (r.status === "queued") {
      const why = r.targetStatus === "waiting-on-user"
        ? ` ${who} is waiting on the user, so it goes through after they answer.`
        : r.targetStatus === "working" ? ` ${who} is busy with other work.` : "";
      const hours = Number.isFinite(r.expiresInMs) ? Math.ceil(Number(r.expiresInMs) / 3_600_000) : null;
      const expiry = hours === null ? "" : ` It expires if not picked up within ${hours} hour${hours === 1 ? "" : "s"}.`;
      return { text: `Task ${taskId} is still queued — ${who} hasn't picked it up yet${waitMs ? ` after ${timeout}s` : ""}.${why}${expiry} Keep working and check again later.` };
    }
```

- [ ] **Step 4: Run the proxy tests**

Run: `pnpm vitest run server/drivers/agents-proxy.test.ts`
Expected: PASS. The older queued test still sees "still queued" and "after 45s".

- [ ] **Step 5: Implement the server side**

In `server/index.ts`, add `DELEGATION_TTL_MS, expireStaleDelegations,` to the `./delegations.ts` import (line ~180). Keep the list alphabetical: `DELEGATION_TTL_MS` goes right after `buildDelegationRevivalPrompt,`, and `expireStaleDelegations` right after `discardDelegations, drainDelegations,`.

Directly after `function drainThreadDelegations(threadId: string): void { … }`, add:

```ts
// Queued handoffs expire DELEGATION_TTL_MS after they were queued. A drain
// expires what it touches; this sweep covers a handoff nothing drains — a
// target that never settles while its source sits idle — and wakes each
// delegator the same way a drain-time failure does.
const DELEGATION_SWEEP_MS = 60 * 60 * 1000;
function expireDelegationsNow(): void {
  expireStaleDelegations(commsBus, Date.now(), (receipt) =>
    wakeUndispatchedDelegation(receipt, activeRoutineRunForThread(receipt.sourceThreadId)?.id));
}
```

In the `server.listen` callback, directly after the closing `}` of `for (const threadId of leftover) { … }`, add:

```ts
  // After the boot drain, not before it: that drain already expires stale
  // leftovers, and a sweep ahead of it would wake delegators of stopped
  // routine runs whose handoffs the loop above discards instead.
  setInterval(expireDelegationsNow, DELEGATION_SWEEP_MS).unref();
```

In the `check_delegation` handler, replace:

```ts
            return json(res, 200, {
              status: "queued",
              toBotName: store.bot(toBotId)?.name ?? toBotId,
            });
```

with:

```ts
            const queuedTarget = store.bot(toBotId);
            return json(res, 200, {
              status: "queued",
              toBotName: queuedTarget?.name ?? toBotId,
              ...(stillQueued
                ? {
                  targetStatus: peerStatus(queuedTarget?.activity, queuedTarget?.busy),
                  expiresInMs: Math.max(0, stillQueued.queuedAt + DELEGATION_TTL_MS - Date.now()),
                }
                : {}),
            });
```

In the `ask_bot` fallback comment, replace:

```ts
        // instead: the message waits in the delegation ledger (bounded busy
        // retries, receipts, restart-safe) and the asker gets a task id it
```

with:

```ts
        // instead: the message waits in the delegation ledger (up to 24
        // hours, receipts, restart-safe) and the asker gets a task id it
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both exit 0. If `tsc` flags another reader of `pendingDelegationInfo(...).attempts` or `MAX_BUSY_ATTEMPTS`, switch it to `waiting` / `queuedAt`. Never re-add the old fields.

- [ ] **Step 7: Commit**

```bash
git add server/index.ts server/drivers/agents-proxy.ts server/drivers/agents-proxy.test.ts
git commit -m "feat(delegations): hourly expiry sweep; check_delegation says who a handoff waits on

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification and hand-off

**Files:** none modified, unless a check fails.

- [ ] **Step 1: Run the affected suites and the peer e2e tests**

Run:

```bash
pnpm vitest run server/delegations.test.ts server/peer-roster.test.ts server/chief-of-staff.test.ts \
  server/drivers/agents-proxy.test.ts server/routines-startup.test.ts server/comms.test.ts \
  server/thread-aware-bots.e2e.test.ts server/peer-allowlist.e2e.test.ts
```

Expected: all PASS. `thread-aware-bots.e2e` still sees `Thread #QA: PR #3 on @Quinn waiting for a free slot`.

- [ ] **Step 2: Run the whole Vitest suite**

Run: `pnpm vitest run`
Expected: PASS, and the total test count is higher than on `origin/main`.

- [ ] **Step 3: Review the branch diff**

Run: `git log --oneline origin/main..HEAD && git diff --stat origin/main..HEAD`
Expected: spec + plan + 5 feature commits. Only these files changed:
- `server/delegations*.ts`
- `server/peer-roster*.ts`
- `server/drivers/agents-proxy*.ts`
- `server/index.ts`
- `docs/superpowers/*`

- [ ] **Step 4: Stop for Omkar's manual check**

Do not push. Report the branch state, and hand over this checklist for an OMB2 side-by-side build (the `test-locally` skill):

1. Bot A delegates to Bot B while B is mid-task → one "waiting — they're busy" chip in A's chat. It's delivered when B finishes.
2. Open an approval card on B, then have A delegate → A's chip says B is waiting on you, and A's `list_bots` shows "waiting on the user".
3. Chat with B three or more times before it picks up A's handoff → still delivered, with no "canceled" chip.
