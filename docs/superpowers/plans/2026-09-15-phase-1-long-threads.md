# Phase 1 part 1 — harness-owned compaction: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a thread's last turn carried more context than its budget, the next turn first writes a compaction record and then starts a fresh engine session with a budgeted replay, on every engine.

**Architecture:** Three pure modules (`context-budget.ts`: window and budget; `compaction-summary.ts`: deterministic summary; the existing `context-rebuild.ts`: replay by bytes) plus two small store fields (`usage.lastInput`, `task.contextReset`) and one hook in `startTurn` that runs before the replay is selected. The fresh-session path is the one an edit or an engine switch already takes; nothing new reaches the drivers.

**Tech Stack:** TypeScript on Node strip-only mode (no parameter properties), vitest, the fakes in `server/testing/`.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-1-long-threads-design.md`

## Global Constraints

- Every item works on every engine; state full / degraded / not supported (spec §Engines).
- No behaviour change under budget: T1–T4 scorecard numbers within noise.
- Compaction only between turns; a failure to compact never fails the turn.
- Record writes go through `runCommand` receipts (`compaction.append`).
- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check` clean; full vitest green before the local build.

---

### Task 1: context budget (pure)

**Files:** Create `server/context-budget.ts`, `server/context-budget.test.ts`.

**Produces:** `contextWindowFor(modelId?: string, catalog?: ModelCatalog): { contextWindow: number; source: "forced" | "catalog" | "pattern" | "default" }`; `compactBudget(compactAt: number | undefined, contextWindow: number): number` (a value below 1 is a share of the window, otherwise absolute tokens; default share 0.6; floor 8,000); `estimateTokens(bytes: number): number` (bytes ÷ 4); `shouldCompact(input: { lastInput?: number; estimatedTokens: number; budget: number }): boolean` (reported input wins; estimate only when no input was reported).

- [ ] Test: window from catalog, from the pattern table (`claude-sonnet-5` → 200k, `gpt-5.6-sol` → 200k, `qwen3` → 32k), forced by `OMB_CONTEXT_WINDOW`, default 128k. Budget: 0.6 of 200k = 120,000; absolute 50,000 stays; floor 8,000. shouldCompact: 130k reported over 120k budget → true; 100k → false; no report and estimate 130k → true.
- [ ] Run, see it fail (module missing). Implement (table lifted from #759). Run, pass. Commit `feat(context): budget — model window, compact threshold, reported-or-estimated size (phase 1)`.

### Task 2: the store remembers the last turn's input and a reset flag

**Files:** Modify `server/store.ts` (`TaskUsage` ~408, `addTaskUsage` ~2058, `TaskRecord` ~379 near `rewound`, `TASK_PATCH_FIELDS` ~403, wire fields ~2235, restore ~1883/1112), `server/store.test.ts`.

**Produces:** `TaskUsage.lastInput?: number` (input tokens of the last settled turn); `TaskRecord.contextReset?: boolean` (patchable, persisted and restored like `rewound`).

- [ ] Test: two `addTaskUsage` calls (input 1,000 then 44,000) leave `usage.input === 45_000` and `usage.lastInput === 44_000`; a turn reporting no input leaves `lastInput` untouched. `patchTask(..., { contextReset: true })` round-trips through `saveBots`/reload.
- [ ] Run, fail. Implement. Run, pass. Commit `feat(store): last turn's input per task, and a contextReset flag (phase 1)`.

### Task 3: deterministic compaction summary (pure)

**Files:** Create `server/compaction-summary.ts`, `server/compaction-summary.test.ts`.

**Produces:** `foldPoint(messages: Message[], keepExchanges = 2): { firstKeptId: string; folded: Message[] } | null` (null when fewer than `keepExchanges + 1` user turns exist); `deterministicSummary(folded: Message[], botName: string, maxBytes = 6_000): string` — oldest first: user requests as `User asked: <first 300 chars>` and each digest as its `digestPromptLine`, joined by newlines, trimmed newest-first to `maxBytes` with a leading `[… N earlier lines omitted]`; `MODEL_SUMMARY_PROMPT(folded rendered)` — #759's wording, under 400 words, data-not-instructions guard; `composeSummary(modelSummary: string | undefined, deterministic: string): string`.

- [ ] Test: fold point keeps the last two exchanges; summary lists requests and digest lines oldest first; byte cap trims oldest and says so; compose puts the model summary first.
- [ ] Run, fail. Implement. Run, pass. Commit `feat(context): deterministic compaction summary from digests and requests (phase 1)`.

### Task 4: config

**Files:** Modify `server/config.ts` (~360 schema, ~412 type, ~537 helpers), `server/config.test.ts`.

**Produces:** `context.compactAt?: number` (0 < x < 1 share, or ≥ 1,000 absolute), `context.autoCompact?: boolean` (default true); `contextCompactAt(cfg): number | undefined`, `contextAutoCompact(cfg): boolean`.

- [ ] Test: defaults; share; absolute; a value of 0 or 500 rejected by the schema.
- [ ] Implement, pass, commit `feat(config): context.compactAt and context.autoCompact (phase 1)`.

### Task 5: compaction before a direct turn, fresh session after it

**Files:** Modify `server/index.ts`: extract `appendCompactionRecord(bot, task, { summary, by, firstKeptId, tokensBefore })` from the compact route (~14790); the route sets `contextReset: true`; new `compactBeforeTurn(bot, task, instance)` called in `startTurn` right before `compactionRecord` is read (~5516); `fresh` (~5538) includes `Boolean(task.contextReset)`; at dispatch (~6124) `contextReset` clears together with `resumeCursors: {}` the way `rewound` does; the usage row books `compacted: true` for a turn that followed a harness compaction and `metrics.ts` sums `compactions`. `server/usage-ledger.ts` row gains `compacted?: boolean`; `server/metrics.ts` `MetricsGroup.compactions`.

**Consumes:** Tasks 1–4.

- [ ] Test (`server/metrics.test.ts`): `compactions` summed. Test (`server/context-compaction.e2e.test.ts`, Task 7) covers the rest.
- [ ] Implement:

```ts
async function compactBeforeTurn(bot: BotRecord, task: TaskRecord, instance: ProviderInstance): Promise<boolean> {
  if (!contextAutoCompact(cfg)) return false;
  const selection = task.modelSelection ?? bot.modelSelection;
  const window = contextWindowFor(selection.model, instance.models).contextWindow;
  const budget = compactBudget(contextCompactAt(cfg), window);
  const messages = store.activePath(task.threadId);
  const record = [...messages].reverse().find((m) => m.kind === "compaction" && m.compaction)?.compaction;
  const since = record ? messages.slice(messages.findIndex((m) => m.id === record.firstKeptId)) : messages;
  const estimated = estimateTokens(since.reduce((n, m) => n + Buffer.byteLength(m.text ?? "", "utf8"), 0));
  if (!shouldCompact({ lastInput: task.usage?.lastInput, estimatedTokens: estimated, budget })) return false;
  const fold = foldPoint(since);
  if (!fold) return false;
  const deterministic = deterministicSummary(fold.folded, bot.name);
  let model: string | undefined;
  if (instance.generateText) {
    model = await Promise.race([instance.generateText(MODEL_SUMMARY_PROMPT(fold.folded, bot.name)).then((t) => t.trim() || undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20_000))]).catch(() => undefined);
  }
  appendCompactionRecord(bot, task, { summary: composeSummary(model, deterministic), by: "harness", firstKeptId: fold.firstKeptId, tokensBefore: task.usage?.lastInput ?? estimated });
  store.patchTask(bot.id, task.threadId, { contextReset: true });
  return true;
}
```

- [ ] Wire, typecheck, lint. Commit `feat(harness): compact a thread before its next turn when the last turn crossed the budget, then start fresh (phase 1)`.

### Task 6: fake engines report a chosen input size

**Files:** Modify `server/testing/fake-claude-cli.ts` (~475, ~511), `fake-codex-app-server.ts` (usage), `fake-pi-cli.ts` (~84, ~114), `fake-acp-cli.ts` (~505).

**Produces:** env `FAKE_CLAUDE_INPUT_TOKENS`, `FAKE_CODEX_INPUT_TOKENS`, `FAKE_PI_INPUT_TOKENS`, `FAKE_ACP_INPUT_TOKENS`: when set, the fake reports that many input tokens per turn.

- [ ] Implement with the default unchanged; existing suites unaffected. Commit `test(fakes): report a chosen input token count per turn`.

### Task 7: e2e matrix

**Files:** Create `server/context-compaction.e2e.test.ts` (modelled on `digest.e2e.test.ts`).

- [ ] For each fake (Claude, Codex, ACP, pi) with `FAKE_*_INPUT_TOKENS=200000` and server env `OMB_CONTEXT_WINDOW=100000`: three turns on one thread. After turn 2 (the first settled turn crossed the budget, turn 3 compacts first): exactly one `compaction` row exists with `by: "harness"`; on Claude the dump written per turn shows turn 3's prompt carries `[Summary of the conversation before this point`; on the ACP echo the reply echoes the summary lead; the task's `contextReset` is false again after dispatch; `/api/metrics` reports `compactions: 1`. A thread under budget (`FAKE_*_INPUT_TOKENS` unset) never compacts. `context.autoCompact: false` never compacts.
- [ ] Run red, wire until green. Commit `test(harness): compaction across every fake engine (phase 1)`.

### Task 8: scorecard T5 and docs

**Files:** Modify `scripts/bench/scorecard.ts` (add T5), `docs/verification/harness-scorecard.md`; create `docs/verification/context-compaction.md`; update `docs/plans/2026-09-14-phase-0-foundation.md` findings (F3/F5 status unchanged) and add `docs/plans/2026-09-15-phase-1.md` pointing at the spec and plan.

- [ ] T5: new bot, 10 turns, each: "Append 100 lines of the form 'entry N' to log.txt with one shell loop, then print the whole file with cat, then reply with only the total line count." Correct when the reply contains the expected count (100 × turn). Record per turn; the table adds a `T5 input at turn 10` line and `T5 total`.
- [ ] Commit `docs(bench): scorecard T5 long thread; compaction recipe (phase 1)`.

### Task 9: local build and measurement (no code)

- [ ] Full vitest, typecheck, lint, i18n. Side-by-side app (`OMB3`) from the branch. Standalone harness on main and on the branch, one after the other; T1–T5 with `--engine claude --switch-to codex`; record `docs/bench/scorecard/2026-09-15-phase1-long-threads.md`. PRs only if T5 improves and T1–T4 hold.
