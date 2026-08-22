# OpenMausBot Harness Upgrades v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the harness's broken context-rebuild paths, add the missing
resilience and visibility primitives, and unlock local models — in an order
where each round pays for the next.

**Architecture:** OpenMausBot is itself a harness; `server/store.ts` is the
canonical cross-engine record and every path that turns it back into model
context is load-bearing. This plan keeps v1's reframe and rounds, but corrects
its scope against the code as it actually is today: two items were partly
built already (attachments, redaction), one was mis-architected for CLI
drivers (tool deadlines), one is speculative (generation fencing), and one
missing Round-1 item was hiding in the open questions (per-bot `cwd`).

**Tech Stack:** TypeScript (`--experimental-strip-types`), vitest, pnpm,
Electron + Vite. Tests: `pnpm vitest run <file>`; typecheck: `pnpm typecheck`.

**Spec:** `docs/plans/agent-harness-upgrades.md` (v1). This document
supersedes its ordering and scope; v1's **Verified findings**, **Design**
sections, and **Upstream references** (the section at the end of v1 listing
what was taken from pi, deepseek-harness, mem0/Letta) remain the design
detail for items this plan carries forward unchanged. Where this plan says "design as v1
item N", the executor reads that section of v1.

## Global Constraints

- Node runs server TS directly via `--experimental-strip-types`; imports use explicit `.ts` extensions.
- Never break the one-file driver promise: a new provider is one file in `server/drivers/` plus one registration.
- Nothing is ever deleted from the store record; only model-facing rebuilds are bounded.
- `~/.openmausbot` is shared across app versions — every new field or message kind must be ignorable by an older build.
- e2e tests follow the `server/branching.test.ts` pattern: real server, fake CLI (`server/testing/fake-acp-cli.ts`), POSIX-gated.
- All 59 existing test files must stay green (`pnpm test`); v1's "82 test files" figure was wrong.

---

## What changed from v1, and why

Every v1 factual claim was re-verified against the repo on 2026-08-17.
Nearly all held. These did not, and they reshape the plan:

| # | v1 said | Repo says | Change |
|---|---------|-----------|--------|
| 1 | "Input is text-only", build attachments from scratch | `src/lib/composer-attachments.ts` + tests already implement paste/file attachments, drop handling, size limits, and `composeMessage` folding into the prompt | Item 2 rescoped to **images only**, extending the existing module |
| 2 | Redaction reuses `auto-approve.ts` patterns | `server/redact.ts` already ships `redactSecrets` with masking, shape preservation, and tests | Item 10 rescoped to a **new call site + content rules** on the existing function |
| 3 | Tool deadlines/loop detection "harness-side so they work for every driver" | CLI drivers run tools *inside* the CLI; the harness observes tool events but can only interrupt the whole turn, and advisory injection needs mid-turn steering (v1 item 17) | Item 9 split: repeat-*detection* stays early (observe + surface), enforcement moves **after** steering |
| 4 | Generation fencing in Round 2 | No observed instance of the bug; the repo already has two staleness notions and v1 itself warns three is how you get an uncatchable bug | **Deferred** until the raw inspector shows a stale event actually landing |
| 5 | Open question 1: "Is `cwd` surfaced per bot?" | It is not — `turn.cwd` is accepted by every driver (`claude.ts:399`, `codex.ts:107`, `acp/core.ts:239`, `antigravity.ts:141`) and nothing in `src/` sets it | Promoted to **Round 1** per v1's own criterion; driver side is already done |
| 6 | 82 test files | 59 (`*.test.*` outside `node_modules`) | Migration budget in risks reduced accordingly |
| 7 | Raw inspector listed 15th, "build it early" | Agreed — so the plan should actually put it early | Moved to **Round 1**, right after the model-switch fix |

---

## Round 1 — broken, missing, or pays for everything after

Order within the round is execution order (1.3 and 1.6 were skipped on 2026-08-17 and now sit at 3.4 and 3.5).

### 1.1 Fix model-switch context loss *(v1 item 1 — detailed task plan below)*

Verified broken: a new instance has no `resumeCursors` entry, doesn't set
`rewound`, isn't grok — so it receives the latest message and nothing else
(`server/index.ts:806–826`, `:979`). The fix reuses the existing rewind
replay branch with a distinct `fresh` marker. Full TDD breakdown in
**Task 1** below; execute it first.

### 1.2 Raw event inspector *(v1 item 15, moved up)*

`RuntimeEventBase.raw` already carries the native payload; surface it
per-thread with tool calls, timestamps, and a raw toggle. Design as v1
item 15. Build it now because items 1.4–2.x are all diagnosed through it,
and because deferred generation-fencing needs its evidence.

### 1.3 Auto-retry in the main drivers — **skipped for now, moved to 3.4**

Decided 2026-08-17 after 1.1 and 1.2 shipped: deferred to the end of
Round 3 (see 3.4). The finding still stands; the item just isn't next.

### 1.4 Per-bot working directory *(promoted from v1 open question 1)*

The smallest item in the plan: every driver already accepts `turn.cwd`
and defaults to `homedir()`. Add `cwd?: string` to `BotRecord`
(`server/store.ts`), pass it at dispatch in `server/index.ts` next to the
existing `integrations` wiring, expose it in the bot profile UI with a
folder picker (Electron dialog), and show the active folder in the chat
header. Done when a bot pointed at a project folder runs its shell tools
there on every driver.

### 1.5 Cost and usage visibility *(v1 item 5)*

Verified: `cost` on `turn.completed` (`server/contracts.ts:92`) and
`thread.token-usage.updated` are emitted by all main drivers; the only
`cost` reference in `src/` is a dormant field in `routines.ts`. Design as
v1 item 5, including the metered-vs-subscription labeling.

### 1.6 Image attachments *(v1 item 2, rescoped)* — **skipped for now, moved to 3.5**

Decided 2026-08-17: not next. The rescoped design is recorded at 3.5.

### 1.7 Cross-thread search *(v1 item 4)*

Design as v1 item 4 (server-side linear scan first, `activity` kinds
included, results land via `switchBranch`).

---

## Round 2 — harness guarantees

### 2.1 Liveness reaper *(v1 item 6)* — design as v1. Prerequisite for 2.3 and Round 3 steering.
### 2.2 Portable context *(v1 item 7)* — design as v1, all four parts (catalog `contextWindow`, activity in replays, compaction kind, target-sized rebuild). The single largest item; the raw inspector (1.2) and the fixed rebuild path (1.1) are its scaffolding.
### 2.3 Durable delegations *(v1 item 8)* — design as v1; drain after 2.1's reconciliation.
### 2.4 Tool-result redaction *(v1 item 10, rescoped)* — a result-side hook that calls the existing `redactSecrets` (`server/redact.ts`) before `store.appendMessage`, extended with *content* patterns (key-shaped values in file reads) alongside its current *key-name* rules, plus the `SENSITIVE` path list from `server/auto-approve.ts`. Redact the stored copy. New tests extend `server/redact.test.ts`.
### 2.5 Fail-closed approvals *(v1 item 11)* — design as v1 (`allowed-once | rejected | cancelled | unavailable`, `request.opened` references the tool item by `itemId`). Land alone.
### 2.6 Emit inside the store *(v1 item 13)* — design as v1: make `appendMessage`/`patchBot` emit as part of writing; explicitly **not** the universal `commit()` refactor.
### 2.7 Server-side activity state *(v1 item 14)* — design as v1: five states, `busy` kept as a derived getter, harness-only readers first (221 refs / 36 files migrate incrementally).
### 2.8 Repeat-call **detection** *(v1 item 9, first half)* — observe-only: a sliding window over streamed tool events keyed on name + normalized args, surfacing "same call × N" in the UI (via 1.2's inspector and a thread banner) with a one-click interrupt. No injection, no per-call termination — the harness cannot do either for CLI drivers until steering exists.

---

## Round 3 — unlocked by the first two

### 3.1 Local models *(v1 item 16)* — design as v1; blocked on 2.2, then nearly free starting from `grok.ts`.
### 3.2 Mid-turn steering *(v1 item 17)* — design as v1, including the stdin-EOF verification gate (`claude.ts:536` — answer open question 3 **before** designing the queue) and the 2.1 prerequisite.
### 3.3 Tool deadlines and loop **enforcement** *(v1 item 9, second half)* — with steering available, escalate 2.8's detection: inject the advisory note at the next safe point, terminate past the hard threshold. Per-call deadlines only where the harness actually owns the call; for CLI drivers the deadline remains "interrupt the turn", stated honestly in the UI.
### 3.4 Auto-retry in the main drivers *(v1 item 3, was 1.3 — skipped on 2026-08-17 and moved here)* — verified: zero retry in `claude.ts` / `codex.ts` / `grok.ts` while `box.ts`, `webhooks.ts`, and `acp/core.ts` all have it. Design as v1 item 3: classify transient (429, 5xx, overloaded, connection reset) vs terminal (auth, invalid model, quota); backoff + jitter with a small attempt cap; a `turn.retrying` runtime event so the UI shows it (the inspector from 1.2 makes this visible for free); an abort path so an interrupt during a retry cancels the whole turn; a retry after partial output discards the partial rather than duplicating it. Done when a simulated 529 produces a visible retry and a completed turn, and an invalid API key fails immediately without retrying.
### 3.5 Image attachments *(v1 item 2, was 1.6 — skipped on 2026-08-17 and moved here)* — the paste/file/drop layer already exists in `src/lib/composer-attachments.ts`; only the image path is missing. Design: `POST /api/attachments` (image mimes, ≤10 MB) writes `~/.openmausbot/attachments/<uuid>.<ext>` and returns a path; the composer shows a thumbnail chip and `composeMessage` emits `<attached-image path="…"/>` — every CLI engine opens the file by path, no per-driver encoding; the transcript parses the tag into a thumbnail; `capabilities.images` per driver gates the paste (Claude/Codex/Antigravity/ACP true, grok/boxAgent false); `SendTurnInput.images` for API drivers waits for a second API driver (3.1). Done when a pasted screenshot reaches Claude, renders in the transcript, survives reload, and a grok bot refuses it politely.

---

## Deferred

Everything in v1's deferred list stays deferred for v1's reasons (shared
memory, skills-as-personalities, spill storage, tree-navigation UI, remote
access groundwork, decomposing `server/index.ts`), plus:

- **Generation fencing** *(was v1 item 12).* Rare, no observed instance,
  and it would add a third staleness notion beside `rewound` and
  `resumeCursors` — v1's own cross-cutting risk. Revisit only when the raw
  inspector (1.2) captures a stale event from a disposed instance landing
  on a live turn. If it lands, first unify the existing two notions.

## Process improvements (the "what we need to do" beyond code)

1. **Answer the empirical open questions before their dependent items, not
   during.** v1 open questions 2 (Codex mid-turn input), 3 (Claude CLI EOF
   semantics), and 4 (Ollama `/v1/models` context window) are each a
   half-day spike with a throwaway script; run them during Round 1 so
   Rounds 2–3 designs are grounded. Record answers in this file.
2. **One item per PR, tests in the same PR.** Contract-touching items
   (1.6, 2.5, 2.7) ripple through driver tests — budget that migration
   inside the item, not after it.
3. **Re-verify before building.** v1 was written 2026-08-17 and was
   already stale in two places (attachments, redaction) because the code
   moves. Each task below starts with a verification step for the same
   reason.
4. **Keep the two-transcript rule visible.** Every rebuild-path PR
   description must state: display path untouched, nothing deleted, only
   the model-facing rebuild is bounded.

---

# Task 1: Fix model-switch context loss

**Files:**
- Create: `server/turn-context.ts`
- Create: `server/turn-context.test.ts`
- Modify: `server/index.ts:806-826` (transcript/turnText block), `:979` (resumeCursor line stays as-is — verify only)

> **As built (#180):** the naive rule below — "fresh = this instance has no
> cursor" — was implemented first and failed manual testing on A → B → A
> (the first engine had a cursor from days earlier and resumed a stale
> session). The shipped contract is **dispatch-based**: `TaskRecord.
> lastInstanceId` is set by `store.markTaskDispatched()` after every
> `sendTurn`, and `engineIsFresh({ instanceId, lastInstanceId, resumeCursors,
> transcript })` decides replay — a different last instance ⇒ fresh; legacy
> tasks without the field fall back to the cursor map (a lone own cursor
> keeps resuming; anything ambiguous replays); a seeded greeting alone never
> triggers a replay. `resumeCursor` is passed only when `resume` is true.
> Steps below are kept as written for the record; where they differ, the
> code and `server/turn-context.test.ts` are authoritative.

**Interfaces:**
- Consumes: `store.activePath(threadId)` (exists), `task.resumeCursors: Record<InstanceId, unknown>` (exists, `server/store.ts:117`), `bot.rewound` (exists), `task.lastInstanceId` (new, see above).
- Produces: `buildTurnContext(input: TurnContextInput): { turnText: string; resume: boolean }` and `engineIsFresh(...)` from `server/turn-context.ts`; `store.markTaskDispatched(botId, threadId, instanceId)` — item 2.2 (portable context) later replaces `buildTurnContext`'s internals; its signature is the seam.

```ts
// server/turn-context.ts — the produced interface, in full
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean; // driverKind === "grok" today
}
export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
};
```

- [ ] **Step 1: Verify the bug still exists**

Read `server/index.ts` around the `slice(-40)` transcript block and confirm:
`rewound` is still the only trigger for inline replay, and
`task.resumeCursors[instanceId]` is still the only session lookup. If a
`fresh`/rebuild marker already exists, stop — this task may be done.

- [ ] **Step 2: Write the failing unit tests**

```ts
// server/turn-context.test.ts
import { describe, expect, it } from "vitest";

import { buildTurnContext } from "./turn-context.ts";

const transcript = [
  { role: "user" as const, text: "my dog is named Biscuit" },
  { role: "assistant" as const, text: "Noted — Biscuit." },
];

describe("buildTurnContext", () => {
  it("passes text through untouched on a plain resumed turn", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: false, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: true });
  });

  it("replays inline on rewind, exactly like the existing behaviour", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: true, fresh: false, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("rewound this conversation");
    expect(out.turnText).toContain("User: my dog is named Biscuit");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("replays inline for a fresh engine with prior history — the model-switch fix", () => {
    const out = buildTurnContext({ text: "hi", transcript, rewound: false, fresh: true, replaysNatively: false });
    expect(out.resume).toBe(false);
    expect(out.turnText).toContain("joining this conversation");
    expect(out.turnText).not.toContain("rewound"); // distinct marker, distinct preamble
    expect(out.turnText).toContain("Assistant: Noted — Biscuit.");
    expect(out.turnText.endsWith("hi")).toBe(true);
  });

  it("never wraps for native-replay drivers — they get history via SendTurnInput.transcript", () => {
    for (const flags of [{ rewound: true, fresh: false }, { rewound: false, fresh: true }]) {
      const out = buildTurnContext({ text: "hi", transcript, ...flags, replaysNatively: true });
      expect(out.turnText).toBe("hi");
    }
  });

  it("does not wrap a fresh engine on an empty thread — nothing to replay", () => {
    const out = buildTurnContext({ text: "hi", transcript: [], rewound: false, fresh: true, replaysNatively: false });
    expect(out).toEqual({ turnText: "hi", resume: false });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run server/turn-context.test.ts`
Expected: FAIL — cannot find module `./turn-context.ts`.

- [ ] **Step 4: Implement `server/turn-context.ts`**

```ts
// Building the text a driver actually receives. Two situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed) and a fresh engine (this instance has no session here — the
// user switched the bot's model mid-thread). They coincide today but are
// distinct markers on purpose: rewound also invalidates OTHER instances'
// cursors, fresh does not.
export interface TurnContextInput {
  text: string;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  rewound: boolean;
  fresh: boolean;
  replaysNatively: boolean;
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";

export function buildTurnContext(input: TurnContextInput): { turnText: string; resume: boolean } {
  const { text, transcript, rewound, fresh, replaysNatively } = input;
  const resume = !rewound && !fresh;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  if (!replay) return { turnText: text, resume };
  return {
    turnText: [
      rewound ? REWOUND_PREAMBLE : FRESH_PREAMBLE,
      "",
      ...transcript.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`),
      "",
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].join("\n"),
    resume,
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run server/turn-context.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Wire it into dispatch**

In `server/index.ts`, replace the inline `rewound`/`turnText` block
(currently `const rewound = threadId === bot.threadId && ...` through the
`turnText` ternary) with:

```ts
const rewound = threadId === bot.threadId && Boolean(bot.rewound);
// a fresh engine: no cursor for THIS instance, but the thread has history
const fresh = !rewound && task.resumeCursors[instanceId] === undefined && transcript.length > 0;
const { turnText, resume } = buildTurnContext({
  text,
  transcript,
  rewound,
  fresh,
  replaysNatively: instance.driverKind === "grok",
});
```

and change the `sendTurn` call's cursor line from
`resumeCursor: rewound ? undefined : task.resumeCursors[instanceId]` to
`resumeCursor: resume ? task.resumeCursors[instanceId] : undefined`
(behaviour-identical: a fresh instance's cursor is already `undefined`).
Add the import: `import { buildTurnContext } from "./turn-context.ts";`
Leave the post-dispatch `if (rewound) store.patchBot(...)` exactly as-is —
`fresh` must NOT clear other instances' cursors; switching back must still
resume the old engine's native session.

- [ ] **Step 7: Typecheck and run the neighbouring suites**

Run: `pnpm typecheck && pnpm vitest run server/turn-context.test.ts server/branching.test.ts server/index.test.ts`
Expected: PASS. The branching e2e pins that rewind behaviour is unchanged.

- [ ] **Step 8: e2e verification of the fix itself**

Add to `server/branching.test.ts`'s config a third instance
`second: { driver: "grokAgent", config: { cli: FAKE_CLI, fullAuto: true } }`,
then a test that: creates a bot on `happy`, runs one turn mentioning a
distinctive token (e.g. `Biscuit`), patches the bot's
`modelSelection.instanceId` to `second` via `PATCH /api/bots/:id`, sends a
follow-up, waits for the reply, and asserts the *prompt* the second fake
received contains `User:` and `Biscuit`. The fake's reply text is fixed, so
assert via the native protocol log: the driver tees verbatim protocol
messages **per thread** to `join(home, ".openmausbot", "native",
`${bot.threadId}.ndjson`)`. Read that one file, keep the `dir === "out"`
entries whose `msg.method === "session/prompt"`, and tell the prompts apart
by **order and content**: prompt 1 (first engine) carries no replay
wrapper; prompt 2 (second engine) matches
`/joining this conversation[\s\S]*User: my dog is named Biscuit/`; and prompt 3
after switching back to the first engine must match
`/joining this conversation[\s\S]*User: my dog is named Biscuit/` too.
(There is no per-instance log; the tee is per thread.)

Run: `pnpm vitest run server/branching.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 9: Full suite and commit**

Run: `pnpm test`
Expected: green (59 test files + updater test).

```bash
git add server/turn-context.ts server/turn-context.test.ts server/index.ts server/branching.test.ts server/testing/fake-acp-cli.ts
git commit -m "fix: rebuild context when a bot's engine switches mid-thread"
```

---

## Self-review notes

- v1 coverage: every v1 item appears above as carried (1,3,4,5,6,7,8,11,13,14,15,16→3.1,17→3.2), rescoped (2→1.6/3.5, 9→2.8+3.3, 10→2.4), promoted (open question 1→1.4), or deferred with cause (12). Deferred list carried whole.
- Task 1's `resume` flag deliberately reproduces today's cursor semantics; the only behaviour change is the `fresh` replay path.
- Follow-on tasks (1.2 onward) get their own bite-sized plans as they are picked up, per the scope check — each is an independent subsystem with its own test cycle.
