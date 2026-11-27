# Usage Accounting and Budgets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the single `input` token figure into fresh input, cache creation, and cache read so the Usage screen stops reading as a runaway bill, then add per-bot and per-workspace spend caps enforced at turn dispatch.

**Architecture:** `TaskUsage` gains three fields and keeps `input` as a derived total for the ~10 existing readers. The Claude driver's two divergent usage formulas are unified. Budgets live in `AppConfig` and on `BotRecord`, and are checked in one place — immediately before `startTurn` dispatches — so every entry point (chat, routine, webhook, delegation) inherits the cap for free.

**Tech Stack:** TypeScript, Node 24, Vitest, React, Tailwind.

**Spec:** none — this plan is its own spec. The motivating observation is recorded in "Background" below.

## Global Constraints

See [the roadmap](2026-08-31-00-control-plane-roadmap.md#global-constraints). Every task's requirements implicitly include that section. The two that bite hardest here:

- The test floor is `TEST_COUNT_FLOOR = 1070` in `scripts/test-floor.mjs`. This plan only adds tests; never edit it.
- Persisted records written by a newer build must load in an older one. `TaskUsage` records predating these fields must read as zero, not `NaN`.

---

## Background: what is actually wrong

A user reported a bot showing **15.4M tokens / $13.97 across ~4 turns** and reasonably
concluded something was broken. Three findings, all verified:

1. **The cost is correct and is not ours.** `total_cost_usd` comes straight from the
   Claude CLI's `result` frame (`server/drivers/claude.ts:837`) and is banked exactly
   once per turn from `turn.completed` (`server/store.ts:990`, `server/index.ts:1052`).
   There is no double count and no quadratic growth from `--resume`.
2. **The token figure is honest but useless.** `input` folds fresh input, cache
   creation, and cache reads into one number (`server/drivers/claude.ts:840`). In an
   agentic turn the cache reads dominate by 10–50×, because every tool-call round trip
   re-reads the whole cached prefix. 15.4M over 4 turns is ~20 round trips at ~190k
   cached context — normal, not a leak. The Usage screen then renders
   `usage.input + usage.output` as one "Tokens" column
   (`src/components/UsageSection.tsx:50`), so a normal session looks catastrophic.
3. **A real bug.** The live in-flight counter at `server/drivers/claude.ts:817` omits
   `cache_creation_input_tokens`; the banked figure at `:840` includes it. The number
   visibly jumps when a turn settles.

Cache reads bill at roughly a tenth of input, which is why 15.4M tokens produced
$13.97 rather than ~$46. The fix is to stop presenting three quantities as one.

---

## File map

- Modify `server/store.ts`: extend `TaskUsage`, extend `addTaskUsage`, add budget fields to `BotRecord`.
- Modify `server/contracts.ts`: extend the turn-usage shape drivers report.
- Modify `server/drivers/claude.ts:817,840`: one formula, three fields.
- Modify `server/drivers/codex.ts`, `server/drivers/grok.ts`: report the new fields where the provider exposes them, zero where it does not.
- Create `server/budget.ts`: pure cap evaluation — no I/O, no store access.
- Create `server/budget.test.ts`.
- Modify `server/index.ts`: enforce at dispatch, expose budget config, emit a `budget.exceeded` runtime event.
- Modify `server/config.ts`: workspace-level budget in `AppConfig`.
- Modify `src/lib/usage.ts`: sum the new fields; add `freshTokens()`.
- Modify `src/lib/usage.test.ts`.
- Modify `src/components/UsageSection.tsx`: split the Tokens column.
- Create `src/components/BudgetSection.tsx`: the cap editor in App Settings.
- Modify `src/components/SettingsPanel.tsx`: mount it.
- Modify `docs/` — no new doc; extend the Usage copy in place.

---

### Task 1: Split TaskUsage into three input classes

**Files:**
- Modify: `server/store.ts:202-209` (`TaskUsage`), `server/store.ts:990-1012` (`addTaskUsage`)
- Modify: `server/contracts.ts` (the `{ input?, output? }` usage shape on turn settle)
- Test: `server/store.test.ts`

**Interfaces:**
- Produces: `TaskUsage { inputFresh: number; inputCacheWrite: number; inputCacheRead: number; input: number; output: number; costUsd: number | null; turns: number }`. `input` stays as the sum of the three so existing readers keep working.
- Produces: `addTaskUsage(botId, threadId, turn: { inputFresh?, inputCacheWrite?, inputCacheRead?, output?, costUsd })`.

- [ ] Write a failing test in `server/store.test.ts`: banking a turn with `{ inputFresh: 1000, inputCacheWrite: 200, inputCacheRead: 50_000, output: 300 }` produces a task usage whose three input fields are exact and whose `input` equals `51_200`.
- [ ] Write a second failing test: a task record persisted **without** the new fields (write `{ input: 900, output: 100, costUsd: null, turns: 1 }` directly) reads back with `inputFresh: 0, inputCacheWrite: 0, inputCacheRead: 0` and a preserved `input: 900` — a legacy record must never become `NaN` and must never lose its total.
- [ ] Write a third failing test: a driver reporting `NaN`, a negative, or `undefined` for any of the three contributes zero, matching the existing `clean()` discipline.
- [ ] Run `pnpm vitest run server/store.test.ts`; expect failures for the missing fields.
- [ ] Extend `TaskUsage` with the three fields. In `addTaskUsage`, accumulate each independently through the existing `clean()` helper, then set `input` to the sum of the three accumulated values **plus** any legacy `prev.input` excess that the three cannot account for — compute `legacy = Math.max(0, prev.input - (prev.inputFresh + prev.inputCacheWrite + prev.inputCacheRead))` before accumulating and carry it forward, so a record that predates the split keeps its historical total intact.
- [ ] Run `pnpm vitest run server/store.test.ts`; expect PASS.
- [ ] Run `pnpm vitest run server/` to confirm no existing reader of `usage.input` broke.
- [ ] Commit `feat(usage): split banked input into fresh, cache-write, and cache-read`.

---

### Task 2: One usage formula in the Claude driver

**Files:**
- Modify: `server/drivers/claude.ts:813-820` (the `assistant` live counter), `server/drivers/claude.ts:833-845` (the `result` settle)
- Test: `server/drivers/claude.test.ts`

**Interfaces:**
- Consumes: the `addTaskUsage` shape from Task 1.
- Produces: both emission sites use one helper, `usageFrom(u): { inputFresh, inputCacheWrite, inputCacheRead, output }`, exported from `server/drivers/claude.ts` for its test.

- [ ] Write a failing test in `server/drivers/claude.test.ts`: feed a `result` frame with `usage: { input_tokens: 1200, cache_creation_input_tokens: 4000, cache_read_input_tokens: 180_000, output_tokens: 900 }` and assert the settled usage carries exactly those four values in the four fields — not a sum.
- [ ] Write a second failing test that is the actual bug: feed an `assistant` frame and a `result` frame carrying identical `usage` objects, and assert the live `thread.token-usage.updated` payload and the settled payload agree on every field. Today the live path drops `cache_creation_input_tokens` and they disagree.
- [ ] Run `pnpm vitest run server/drivers/claude.test.ts`; expect both to fail.
- [ ] Add `export function usageFrom(u)` mapping `input_tokens → inputFresh`, `cache_creation_input_tokens → inputCacheWrite`, `cache_read_input_tokens → inputCacheRead`, `output_tokens → output`, each `|| 0`. Call it from both sites. Replace the comment at `:835` — it currently justifies the merge ("cache reads count as input"), which is no longer what the code does; state instead that the three are reported separately because they price differently and only the total fills the window.
- [ ] Run `pnpm vitest run server/drivers/claude.test.ts`; expect PASS.
- [ ] Commit `fix(claude): report cache-write tokens on the live counter too`.

---

### Task 3: The other drivers report what they know

**Files:**
- Modify: `server/drivers/codex.ts`, `server/drivers/grok.ts`
- Test: `server/drivers/codex.test.ts`, `server/drivers/grok.test.ts`

- [ ] Write a failing test per driver: a settled turn reports its provider's token figures in `inputFresh` and `output`, with `inputCacheWrite` and `inputCacheRead` at `0` when the provider exposes no cache breakdown.
- [ ] Run both focused suites; expect failures.
- [ ] Map each driver's existing token extraction onto the new field names. Do not invent a cache split a provider does not report — zero is the honest value and Task 5 renders it as "not reported" rather than "none".
- [ ] Run both focused suites; expect PASS.
- [ ] Commit `feat(usage): report the split from codex and grok`.

---

### Task 4: Pure budget evaluation

**Files:**
- Create: `server/budget.ts`
- Test: `server/budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BudgetLimits { botUsd?: number; workspaceUsd?: number }
  export interface BudgetSpend { botUsd: number | null; workspaceUsd: number | null }
  export type BudgetVerdict =
    | { ok: true }
    | { ok: false; scope: "bot" | "workspace"; limitUsd: number; spentUsd: number };
  export function evaluateBudget(limits: BudgetLimits, spend: BudgetSpend): BudgetVerdict;
  ```

- [ ] Write failing tests: under the cap returns `{ ok: true }`; at or over the bot cap returns the bot verdict; over both caps returns the **workspace** verdict (the wider cap is the more important thing to tell a person about); an absent limit never blocks; a `null` spend — meaning no engine on this bot ever reported a price — never blocks, because a cap must not silently stop work it cannot measure.
- [ ] Write a failing test that a limit of `0` blocks everything, and is distinct from an absent limit. `0` is a deliberate freeze; `undefined` is "no cap".
- [ ] Run `pnpm vitest run server/budget.test.ts`; expect FAIL, module not found.
- [ ] Implement `evaluateBudget` as a pure function. No imports from `store.ts`, `config.ts`, or `node:fs` — this module must be testable without a harness.
- [ ] Run `pnpm vitest run server/budget.test.ts`; expect PASS.
- [ ] Commit `feat(budget): pure cap evaluation`.

---

### Task 5: Persist the limits

**Files:**
- Modify: `server/config.ts` (`appConfigSchema`, `AppConfig`)
- Modify: `server/store.ts` (`BotRecord`)
- Modify: `server/bot-profile.ts` (`BOT_PROFILE_PATCH_FIELDS`, `profilePatchSchema`)
- Test: `server/config.test.ts`, `server/bot-profile.test.ts`

**Interfaces:**
- Produces: `AppConfig.budget?: { workspaceUsd?: number }`, `BotRecord.budgetUsd?: number`.

- [ ] Write a failing test in `server/config.test.ts`: `budget.workspaceUsd` round-trips, rejects negatives and non-finite values, and a config file with an unknown key inside `budget` still loads (forward compatibility).
- [ ] Write a failing test in `server/bot-profile.test.ts`: `budgetUsd` is an accepted profile patch field, rejects negatives, and accepts `null` to clear the cap.
- [ ] Run both; expect FAIL.
- [ ] Add `budgetConfigSchema = z.object({ workspaceUsd: z.number().nonnegative().finite().optional() })` to `server/config.ts` and thread it through `AppConfig`. Note that `appConfigPatchSchema` derives from `appConfigSchema` by omitting `instances`, so the **write** path picks this up with no further change. The read path does not: `GET /api/config` returns a hand-built `configStatus()` (`server/index.ts:4831`), so `budget` must be added there explicitly. Unlike the credential fields it is not a secret, so it is returned by value rather than as a `configured` flag.
- [ ] Add `budgetUsd?: number` to `BotRecord` and to `BOT_PROFILE_PATCH_FIELDS` with a matching zod rule.
- [ ] Run both; expect PASS.
- [ ] Commit `feat(budget): persist workspace and per-bot caps`.

---

### Task 6: Enforce at dispatch

**Files:**
- Modify: `server/index.ts` — the single point where a turn is dispatched, immediately before the `startTurn` call that routines, webhooks, chat, and delegation drains all funnel through
- Test: `server/index.test.ts`

**Interfaces:**
- Consumes: `evaluateBudget` (Task 4), `botUsage`-equivalent summation over `bot.tasks`.
- Produces: a `budget.exceeded` runtime event on the bus carrying `{ scope, limitUsd, spentUsd }`, and a `402`-shaped JSON error `{ error, scope, limitUsd, spentUsd }` on the HTTP path.

- [ ] Write a failing API test: set `budget.workspaceUsd` to `1`, bank a task usage of `$2`, then start a turn and assert it is refused with the budget error and that **no provider process is spawned** — assert against the fake driver's spawn count, not just the response body. A cap that refuses after spawning has not saved anything.
- [ ] Write a failing test that a bot with `budgetUsd` unset is still governed by the workspace cap, and that a bot whose own cap is exceeded is refused while its peers keep working.
- [ ] Write a failing test that clearing the cap immediately unblocks the next turn with no restart.
- [ ] Run `pnpm vitest run server/index.test.ts`; expect FAIL.
- [ ] Sum spend from `bot.tasks[].usage.costUsd` for the bot and across `store.bots` for the workspace, treating `null` as unmeasured per Task 4. Call `evaluateBudget` before dispatch; on `{ ok: false }` emit `budget.exceeded`, append a `decision-log` row (`kind: "user-denied"`, `source: "budget"` — add that source to `DecisionSource` in `server/decision-log.ts`), and return the error without spawning.
- [ ] Run `pnpm vitest run server/index.test.ts`; expect PASS.
- [ ] Run `pnpm vitest run server/`; the routine and webhook suites must still pass unchanged — they inherit the cap and should not need edits. If one fails, the enforcement point is in the wrong place; move it, do not special-case the caller.
- [ ] Commit `feat(budget): refuse a turn that would exceed a cap`.

---

### Task 7: Make the Usage screen readable

**Files:**
- Modify: `src/lib/usage.ts`, `src/lib/usage.test.ts`
- Modify: `src/components/UsageSection.tsx:35-55`

**Interfaces:**
- Consumes: the extended `TaskUsage` from Task 1, mirrored in `src/state/store.tsx`.
- Produces: `export function freshTokens(u: TaskUsage): number` — `inputFresh + inputCacheWrite + output`, i.e. everything that is not a cache read.

- [ ] Write a failing test in `src/lib/usage.test.ts`: `sumUsage` accumulates all three input classes; `freshTokens` excludes `inputCacheRead`; a legacy usage with only `input` set returns its `input + output` from `freshTokens` rather than zero, so old rows do not read as free.
- [ ] Run `pnpm vitest run src/lib/usage.test.ts`; expect FAIL.
- [ ] Implement, mirroring the `TaskUsage` shape into `src/state/store.tsx`.
- [ ] Run; expect PASS.
- [ ] Change the Tokens column to render `formatTokens(freshTokens(usage))` as the primary figure, with cache reads on a dimmed second line reading `+ {formatTokens(usage.inputCacheRead)} cached`. Update the `title` tooltip to name all four quantities. Update the `Card` subtitle to say cache reads are re-read context, billed at a fraction of input — the sentence a person needs in order to not read 15.4M as a runaway.
- [ ] Where a driver reported no cache split at all (all three cache fields zero but `input` non-zero), render the total with no second line rather than "0 cached" — absent data must not read as a measurement.
- [ ] Run `pnpm check:contrast` and `pnpm typecheck`.
- [ ] Commit `feat(usage): separate cache reads from fresh tokens in the usage table`.

---

### Task 8: The cap editor

**Files:**
- Create: `src/components/BudgetSection.tsx`
- Modify: `src/components/SettingsPanel.tsx` (mount below `UsageSection`)
- Test: `src/components/BudgetSection.test.ts`

- [ ] Write a failing test for the pure input parser: `parseBudgetInput("")` → `{ cleared: true }`; `parseBudgetInput("25")` → `{ usd: 25 }`; `parseBudgetInput("$25.50")` → `{ usd: 25.5 }`; `parseBudgetInput("-1")` and `parseBudgetInput("abc")` → `{ error }`. Keep the parser exported and pure so this test needs no DOM.
- [ ] Run; expect FAIL.
- [ ] Implement `parseBudgetInput` and the section: one workspace cap field, and a per-bot list reusing the row layout from `UsageSection`. Show current spend against each cap. When a cap is exceeded, say which bot is blocked and that clearing the field unblocks it immediately.
- [ ] State plainly in the subtitle that caps only govern engines that report a price, and that bots on engines which report none are uncapped. A cap that silently does not apply is worse than no cap.
- [ ] Run the focused test, `pnpm typecheck`, and `pnpm check:contrast`.
- [ ] Commit `feat(budget): add the cap editor to app settings`.

---

## Self-review

**Coverage.** The three findings in Background map to Tasks 2 (the live/settle
disagreement), 1 + 7 (the conflated figure), and 6 (enforcement that the roadmap says
must not be built on the unsplit number). Budgets from the roadmap's Tier 2 map to
Tasks 4–6 and 8.

**Type consistency.** `TaskUsage` gains `inputFresh`/`inputCacheWrite`/`inputCacheRead`
in Task 1 and every later task uses exactly those names — Task 2's `usageFrom`, Task 3's
driver mapping, Task 7's `freshTokens`. `evaluateBudget`/`BudgetVerdict` are defined in
Task 4 and consumed unchanged in Task 6.

**Known risk.** Task 1's legacy-carry arithmetic is the one place a mistake is silent:
it can only be wrong by preserving too little of a historical total. Task 1's second
test pins it. If a future driver starts reporting a cache split for records that already
have a legacy `input`, that bot's total will double-count until its next task. Accepted:
`TaskUsage` is per-task and tasks are short-lived, so the window is one task, not forever.
