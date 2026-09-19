# Phase 1 part 2 — recall: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a direct turn, the harness searches the bot's own notes, conversations and captures with the user's message and hands the best passages to the engine, numbered and fenced, with a visible chip; a fresh session also gets a short "recently" block; memory entries carry an importance the over-budget cut respects; every harness-initiated model call is fingerprinted and booked.

**Architecture:** Four new pure-ish modules (`recall-block.ts`: query, block, Sources line; `supamaus.ts`: REST history client; `harness-calls.ts`: fingerprint, cache, booking; `memory-importance` inside `workspace.ts`) plus a `store.ownThreadIds` helper and one hook in the direct-turn path before `buildTurnContext`, one at settle. Nothing new reaches the drivers except the Claude one-shot's `--output-format json`.

**Tech Stack:** TypeScript on Node strip-only mode, vitest, the fakes in `server/testing/`.

**Spec:** `docs/superpowers/specs/2026-09-15-phase-1-recall-design.md`

## Global Constraints

- Every item works on every engine (spec §Engines); the block travels in the turn text.
- T1–T5 unchanged by construction: a bot with no notes and no other threads gets no block.
- Recall never fails a turn; a source that errors is empty.
- No model call on the turn path. The only model calls touched are the ones being fingerprinted.
- `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check` clean; full vitest green before the local build.

---

### Task 1: importance on the entry grammar, and the over-budget selection
**Files:** `server/workspace.ts` (`memoryEntry`, `DATED_ENTRY`, `TYPED_PREFIX`, `loadMemory`), `server/memory-store.ts` (`memoryCapacity` mirrors the cut), `server/drivers/agents-proxy.ts` (`memory_update.importance`), `server/index.ts` internal memory route, new `server/memory-importance.test.ts`.
- [ ] Tests: `memoryEntry("x", { importance: 5 })` renders `· importance 5 ·`; default omits the segment; an entry line parses importance 5, a hand-written line reads as 3; `loadMemory` under budget returns bytes identical to the file; over budget (250 entry lines, ten of them importance 5 at the end) keeps every importance-5 line, keeps headings, renders in file order, `truncated` true and `dropped` counted; `memoryCapacity` agrees with `loadMemory` on `loadedLines`.
- [ ] Implement; commit `feat(memory): importance on the entry grammar; the over-budget cut keeps the important lines (phase 1 part 2)`.

### Task 2: OR queries and the bot's own thread set
**Files:** `server/message-db.ts` (`ftsQuery(query, mode)`, `recallMessages`/`recallMemory` take `{ mode: "all" | "any" }`), `server/store.ts` (`ownThreadIds(botId)`: own thread, tasks, and every task thread of a room the bot is a member of), tests in `message-db.test.ts`, `store.test.ts`.
- [ ] Tests: `any` query matches a row sharing one term; a 20-term message keeps at most 16 terms; `ownThreadIds` includes a room task thread for a member and not for a non-member.
- [ ] Implement; commit `feat(recall): any-term FTS queries and a bot's own thread set including its rooms`.

### Task 3: the recall block (pure)
**Files:** new `server/recall-block.ts`, `server/recall-block.test.ts`.
**Produces:** `recallQuery(text): string | null` (null under 8 chars; first 500 chars; terms); `renderRecallBlock(passages, recent, { maxChars }): { text, refs }` (numbered `[n] source (date): snippet`, fence markers stripped from snippets, cap, unnumbered "recently" section); `splitSourcesLine(reply): { text, used: number[] | null }`; `recallChipLabel(counts)`.
- [ ] Tests: each rule above, plus an empty passage list with a recent block still renders, and an empty everything renders nothing.
- [ ] Implement; commit `feat(recall): the numbered, fenced recall block and the Sources line (phase 1 part 2)`.

### Task 4: SupaMaus history as a source
**Files:** new `server/supamaus.ts`, `server/supamaus.test.ts` (a local HTTP stub).
**Produces:** `supamausClient({ url?, tokenPath?, fetch? })` → `{ enabled, search(terms, limit), recent(withinMs, limit) }`; 30 s cache; 1 s timeout; hit shape `{ id, at, app, title, text }`.
- [ ] Tests: no token file → `enabled: false` and empty results; stub history filtered by terms over app/title/transcript/dropped text; a stub that never answers → empty within 1.5 s; cache serves a second call without a fetch.
- [ ] Implement; commit `feat(recall): SupaMaus captures as a recall source, read server-side over its local REST (phase 1 part 2)`.

### Task 5: fingerprinted harness model calls
**Files:** new `server/harness-calls.ts`, `server/harness-calls.test.ts`; `server/drivers/claude.ts` (`generate` with `--output-format json`), `server/testing/fake-claude-cli.ts` (json one-shot), `server/drivers/openai-chat.ts` (`generate` returns usage), `server/contracts.ts` (`generate?`), `server/usage-ledger.ts` (`trigger.kind: "harness"`, `fingerprint`), `server/index.ts` (`performCompaction` through `runHarnessCall`).
- [ ] Tests: same fingerprint twice → one underlying call, one ledger row, second returns the cached text; exhausted cap → skipped, no call; a call reporting usage books input/output/cost; the compaction e2e's ledger gains a `harness` row with a fingerprint (asserted in Task 7).
- [ ] Implement; commit `feat(harness): fingerprinted, budget-checked, booked harness model calls; the compaction summariser uses them (phase 1 part 2)`.

### Task 6: wiring in the turn path
**Files:** `server/config.ts` (`recall`), `server/index.ts` (recall before `buildTurnContext`; chip at dispatch; `splitSourcesLine` at `assistant_text`; usage row `recall`; `session_search` widened threads + `captureHits`; room turn memory-only recall), `server/metrics.ts` (`recalls`, `recallsUsed`), `server/usage-ledger.ts` (`recall`).
- [ ] Tests: `index.test.ts` unit-level where the harness pattern allows; the e2e in Task 7 is the proof.
- [ ] Implement; commit `feat(recall): the harness recalls before every direct turn, discloses it, and books it (phase 1 part 2)`.

### Task 7: e2e matrix
**Files:** new `server/recall.e2e.test.ts` (modelled on `context-compaction.e2e.test.ts`).
- [ ] Four fakes: seed memory via `PUT /api/bots/:id/memory`, a first thread with a fact, a new task asking; assert the prompt dump / echo carries `[1]` and `[2]` with both facts, the chip, the usage row, the Sources removal on a scripted Claude reply, the off switch, the 8-character guard, and one `harness` ledger row per compaction with a fingerprint.
- [ ] Commit `test(recall): the recall block, chip and ledger on every fake engine`.

### Task 8: scorecard T6 and the recall set
**Files:** `scripts/bench/scorecard.ts` (T6), new `scripts/bench/recall-set.ts`, `docs/bench/recall-set.json` (24 cases), `docs/verification/harness-scorecard.md`, `docs/verification/recall.md`.
- [ ] Commit `bench(recall): scorecard T6 and the recall set`.

### Task 9: local build and measurement (no code)
- [ ] `pnpm typecheck && pnpm lint && pnpm i18n:check`; full vitest.
- [ ] Standalone harness on main and on the branch, one after the other: T1–T6 and the recall set; record under `docs/bench/scorecard/2026-09-15-phase1-recall.md`; fix any degradation locally first.
- [ ] OMB3 rebuilt on `~/.openmausbot-test`; the chip checked by eye.
- [ ] Update `docs/plans/2026-09-15-phase-1.md` (part 2 status, findings), then the PR stacked on #1272.
