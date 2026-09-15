# Phase 1, part 2: recall — the harness remembers for the bot

Status: design taken on the recommendation (Omkar, Sep 15, 2026: "go with whatever you recommended"). Builds on part 1 (`2026-09-15-phase-1-long-threads-design.md`) and Phase 0. Plan pointer: `docs/plans/2026-09-15-phase-1.md`, part 2. Standing rules: every item works on every engine (full / degraded / not supported, stated); correctness on T1–T5 and the recall set at 100% is the gate, tokens second (decision 19); nothing from Overlay is copied, only rules and shapes (decision 22).

## Goal

A bot uses what it was told or did in an earlier conversation without the person repeating it, on every engine, with no model call on the turn path, and the person can see when it happened. Measured by a recall set (pass/fail cases run live through the standalone harness) and one scorecard task T6 ("told X in one thread, uses X in another"); T1–T5 must not change.

## Problem

Today a bot recalls only when the model decides to call `session_search` (#754). The fake-engine eval passes, but the live behaviour depends on the model thinking to search; the top of `MEMORY.md` loads whole, the rest is invisible; a bot cannot recall its own room work; SupaMaus captures are reachable only through the bot's own MCP; and the compaction summariser (part 1) is a harness-initiated model call that nothing books, so a retry would pay twice.

## What earlier PRs taught (`AGENTS.md` rule 2)

- **#754 (merged): `session_search` / `session_read`, own-bot only, FTS5 over `messages.text`.** Kept as is; part 2 calls the same `recallMessages` at turn start and widens the thread set it searches. Its review asked for fenced hits with an "untrusted reference" rule stated before the content: the recall block does exactly that.
- **#1040 (merged): dated, sourced entries; over-budget refusal; memory files indexed for `session_search`.** The entry grammar is extended, not replaced (`· importance N ·` is optional and hand-written lines stay valid); `recallMemory` is the index part 2 queries.
- **#756 (closed, unmerged): typed sections and a labeled selection when over budget.** Its selection idea (cut by kind, not by position) is taken in the smaller form decision 19 allows: importance then recency, only when over budget, nothing removed under budget. Its section grammar is not taken.
- **#777 (closed): an earlier `session_search`;** superseded by #754.
- **#952 (open, external): per-bot Hindsight memory.** An engine-side memory service; decision 17 says no by default. No code overlap: part 2 touches the prompt path and the store, not the bot settings it adds. Stated in the PR body.
- **#903 / #933 / #934 (open, this account): team memory screens.** Phase 6 surface; no overlap with the turn path.

## Decision

Five pieces, all harness-side:

1. **Recall block at turn start (no model call).** Before a direct turn is dispatched, the harness searches the bot's own notes and conversations with the user's message and puts the best passages into the turn text, numbered, fenced, and marked as reference material. Sources, in rank order: memory files (`recallMemory`, top 4) and the bot's own other threads (`recallMessages`, top 4; the current thread is excluded because it is already in context; room threads the bot is a member of are included). Guards from Overlay, as rules: skip when the user text is under 8 characters; the query is the first 500 characters; the block is capped at 9,000 characters; the block is retrieval-only (nothing is written by this step). The query is an OR of the message's content terms (stop words dropped, at most 16 terms), ranked by bm25; the AND query stays for the bot's own `session_search`.
2. **Where it goes.** In the turn text, ahead of the user's message, never in the system prompt and never in the stored message row. Reason: the volatile system half re-sends the whole memory block to a live Claude process whenever it changes, and the stored row would replay the block forever on the HTTP family. The turn text is per-turn on every engine by nature, so this is **full on all six families**. Old blocks vanish with their session; a compaction replay is built from stored rows and carries none.
3. **Numbered citations and a chip.** Each passage is `[n] <source> (<date>): <snippet>`; the block asks for exactly one final `Sources: [n] [m]` line when the reply relied on a passage, else none. At settle the harness reads that trailing line off the reply, removes it from the stored reply, and finishes the chip. The chip is an `activity` row posted at dispatch, `recalled 3 notes · 1 conversation`, whose expandable output lists the sources with their file, thread and message ids or capture id, and which is patched to `· used [1] [3]` at settle. Room turns get memory-file recall only; recall from private threads in a room stays the bot's explicit `session_search`, which already discloses (#817).
4. **Dynamic block on a fresh session.** When the turn does not resume a session (first turn of a thread, engine switch, rewind, after a compaction) the same envelope carries an unnumbered "recently" section: up to 3 other threads of this bot with a digest in the last 7 days (title + digest line), the last 3 memory-log lines from today and yesterday, and the last 3 SupaMaus captures within the hour (app, one line of text, id). Capped at 1,500 characters. Nothing on a resumed session, so follow-up turns cost nothing extra.
5. **SupaMaus as a recall source.** The harness reads SupaMaus's local REST history (`/v1/history`, loopback, bearer token from `~/Library/Application Support/SupaMaus/server-token`) with a 30-second cache and matches the query's terms in-process over app name, window title, transcript and dropped text. Capture hits are numbered passages like the rest (`capture "ChatGPT" (2026-09-15, id …)`) and count on the chip; `session_search` gains the same source as `captureHits`. Nothing is copied into memory and no second index is built; where SupaMaus is absent (other OSes, no token, server down) the source is silently empty. Off switch `recall.captures: false`. Reading a whole capture on demand is not in this part.
6. **Importance on the entry grammar.** `memory_update` takes an optional `importance` (1–5, default 3); the entry reads `- 2026-09-15 · from chat "X" · importance 5 · text`. Hand-written lines read as 3. `loadMemory` is byte-for-byte unchanged while the file is under budget; over budget it keeps headings and prose, ranks entry lines by importance then date then file order, keeps what fits, renders in file order, and the truncation note says how many lower-importance lines were left out. (Decision 19: order now, cut only on evidence.)
7. **Fingerprinted harness model calls.** A new `harness-calls.ts` wraps every harness-initiated model call, starting with the compaction summariser: fingerprint = hash(kind, thread, turn key, prompt); a completed call's text is kept on disk for 24 hours under that fingerprint, so a retry returns it without a second call or a second booking; before calling, the monthly spend cap (`spendState`) is checked and an exhausted cap skips the call quietly; after calling, one usage row is booked with `trigger: { kind: "harness", call }`, the fingerprint, and the actual tokens and cost. To get actual cost the Claude one-shot runs with `--output-format json` (the `result` object carries `usage` and `total_cost_usd`); the HTTP family already returns usage; a call that reports nothing books an unpriced row. The per-task money cap is Phase 2's; this is its first seam.

Config: `recall: { auto?: boolean (default true), captures?: boolean (default true), maxChars?: number (default 9000) }`. Metrics: usage rows gain `recall: { notes, conversations, captures, bytes, used? }`; `/api/metrics` sums recalls and the share with a Sources line.

## Non-goals

Cutting `MEMORY.md` under budget (Later, decision 19). Cross-bot recall (Phase 6). Room-thread recall inside room turns beyond memory files. Embeddings (Later, only if the recall set shows lexical failing). Reading a full capture from a hit. A per-task money budget (Phase 2). F10's summariser latency (part 1b).

## Engines

| Item | Claude Code | Codex | pi | ACP family | HTTP family | Box agent |
| --- | --- | --- | --- | --- | --- | --- |
| recall block, dynamic block, chip | full (turn text) | full | full | full | full | full |
| captures | full where SupaMaus runs on this machine; absent elsewhere (every engine alike) |
| importance grammar and over-budget selection | harness-side, full everywhere memory loads (API-only and box engines have no workspace, as before) |
| fingerprinted calls | full (`--output-format json`) | n/a (no one-shot) | n/a | n/a | full (usage reported) | n/a |

## Failure boundaries

Recall runs inside the turn's own admission and never fails it: a search error, a SupaMaus timeout (1 s) or a malformed history means an empty source. The block is built synchronously from SQLite; the SupaMaus read is awaited with the timeout. The Sources line is parsed only from the last line of the reply. A fingerprint cache miss after a crash calls again and books again, which is the safe direction. Nothing here writes memory.

## Testing

- Unit: `recall-block.ts` (terms, OR query, numbering, caps, fence stripping, Sources parsing and removal), `memory-entries` importance (grammar round trip, default 3, over-budget selection keeps headings and highest importance, under budget identical bytes), `harness-calls.ts` (same fingerprint returns cached text without a second call, exhausted cap skips, row booked with cost), `supamaus.ts` (no token → disabled, history filtered by terms, timeout → empty), store `ownThreadIds` including room tasks.
- E2E matrix (fake Claude, Codex, ACP, pi): memory file plus an earlier thread hold a fact; a new task asks for it; the engine's prompt dump carries the numbered block with both passages; the chip is present; the usage row carries `recall`; a fake reply ending in `Sources: [1]` is stored without that line and the chip says `used [1]`; `recall.auto: false` yields no block; a message under 8 characters yields no block.
- Scorecard: T6 recall (turn 1 on a new bot states a fact; a second task asks for it with no tools). `docs/bench/recall-set.json` + `scripts/bench/recall-set.ts`: 24 cases (memory-file facts, conversation facts, an updated fact where the newer must win, a negative where nothing was told), run live on main and on the branch, one after the other.
- Local: side-by-side app build; scorecard T1–T6 on main and branch; numbers under `docs/bench/scorecard/`.

## Acceptance

T1–T5 tokens and correctness unchanged; T6 and the recall set pass on the branch at 100% and the main baseline is recorded next to it; the chip shows in the app with sources; the compaction summariser books one row per compaction with a fingerprint and a retry books nothing; `pnpm typecheck`, `pnpm lint`, `pnpm i18n:check` and the full suite green.
