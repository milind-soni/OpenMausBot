# Phase 1, part 1: long threads — harness-owned compaction

Status: approved design (Omkar, Sep 15, 2026). Builds on Phase 0 (`docs/plans/2026-09-14-phase-0-foundation.md`): the compaction record, the digest, replay by bytes, per-turn usage rows. Standing rule: every item works on every engine (full / degraded / not supported, stated).

## Goal

Keep a long thread's context from growing without bound on any engine, without a person restarting anything, and without changing what the bot is asked. Measured by a new scorecard task (T5: ten turns that each print a growing file): input tokens at turn 10 and total tokens per task, main versus branch.

## Problem

Every turn re-sends the whole conversation, old tool output included, until the engine's own compaction fires. Claude Code compacts near its limit and only on its own schedule; Codex, pi and the ACP family never tell the harness anything. The harness today only shapes context when it rebuilds (rewind, engine switch, resume rejection) — a cleanly resumed turn never compacts (proven in #760). So on a long thread the harness has no say at all.

## What earlier PRs taught (rule 2 of `AGENTS.md`)

- **#759 "Own the model-facing context across every engine" (closed, "close and split" by the maintainer; only its resume-recovery piece landed as #1038).** Its budget-as-a-share-of-the-window rule, its model-window pattern table and its compaction prompt wording are lifted here. Its character-count token estimates are replaced by the provider-reported input tokens Phase 0 now books per turn, with the estimate only as a fallback for engines that report none.
- **#760 (closed):** a resumed turn never compacts; only a rebuild does. This design forces the rebuild: after a compaction the next turn starts a fresh session on purpose.
- **#1080 keep-chatting (closed, rebased onto an old tag):** "Compact around" as a hard cap that forces a compact plus a host reset, and a per-turn notebook page. The digest is our notebook page, written by the harness with no model call; the hard cap is the budget below.
- **#1184 (open, this account): quota switch and `[ran: …]` lines in the replay.** The replay half is superseded by Phase 0's digests (part 2, #1243), which carry the same tool history per turn; the quota-switch card is untouched but its branch will need a rebase onto #1243 and should drop its replay commit. Stated in #1243's body.
- **#59 (open, conflicting): per-task execution budgets.** Different thing (limits that stop a run); shares the word "budget" only. No overlap in code once it is rebased.

## Decision

The harness owns compaction, between turns, on every engine:

1. **Context size per task.** Main (commit a8751a22, after this spec was first written) books per task `usage.context.tokens`: what filled the model's window on the last model call of the last turn. That is the number the budget compares — not the turn's summed input, which for a tool-using turn counts every model call and overstates the window by that factor. Where a driver reports no context reading (pi, the ACP family) the last turn's input stands in; where it reports no usage at all, an estimate: bytes of the thread's replayable text since the last compaction ÷ 4.
2. **Budget.** `context.compactAt` in config: a share of the model's window (default 0.6) or an absolute token count. The window comes from the catalog when declared, else a pattern table over the model id (from #759), else 128,000. `OMB_CONTEXT_WINDOW` forces a window for tests. Off switch: `context.autoCompact: false`.
3. **Trigger.** When a direct turn starts and `lastInput ≥ budget`, the harness compacts first: it appends a compaction record (Phase 0's `compaction` message) whose `firstKeptId` is the first message of the last two exchanges, and marks the task `contextReset`.
4. **Summary, deterministic first.** The record's summary is built without a model call: for the folded span, each turn's digest line (what it did) plus each user request (first 300 characters), oldest first, capped at 6,000 bytes newest-first. Where the engine offers `generateText` (Claude, HTTP family) a model summary (#759's prompt, under 400 words) is added in front of the deterministic part; a failure or timeout of that call leaves the deterministic summary alone. Codex, pi and the ACP family get the deterministic summary only: **degraded, stated**.
5. **Fresh session with a budgeted replay.** `contextReset` makes the next dispatch take the existing fresh-session path (the one an engine switch or an edit takes): resume cursor not used for this dispatch, transcript replayed inline through `selectReplay` — summary lead, then the kept exchanges, then the new message. Old tool output is never replayed, so masking is by construction. The flag clears once the turn is dispatched (like `rewound`).
6. **The manual route too.** `POST /api/bots/:id/tasks/:threadId/compact` (Phase 0) now also sets `contextReset`, so a person's compaction takes effect on the next turn instead of only on the next engine switch.
7. **Visible.** The existing compaction chip reads "context compacted · N tokens summarised · by harness"; `/api/metrics` counts compactions per bot and engine.

## Non-goals

Rooms (Phase 6). Mid-turn compaction. Recall (part 2). Prefix fixes and F3 (part 3). Changing Claude Code's own autocompact flag. A model call on engines that offer none.

## Engines

| Engine | Context size | Summary | Fresh session + replay |
| --- | --- | --- | --- |
| Claude Code | reported | model + deterministic | full (fresh `--session-id`, replay in the first prompt) |
| Codex | reported | deterministic | full (new thread, replay in the first prompt) |
| pi | reported where the host sends usage, else estimate | deterministic | full |
| ACP family | estimate unless the agent reports usage | deterministic | full |
| HTTP family | reported | model + deterministic | already replays every turn; the record just shortens the replay |
| Box agent | reported where the box reports | deterministic | full |

## Failure boundaries

Compaction runs before dispatch and inside the same admission guard as the turn; a failure to write the record aborts the compaction, never the turn (the turn then runs on the old session as before). The deterministic summary cannot fail. A model summary is bounded by a 20 s timeout. The record write is a command with a receipt (`compaction.append`, keyed on the thread and the last folded message), so a retried dispatch cannot write two records.

## Testing

- Unit: `context-budget.ts` (window lookup, share/absolute budget, estimate fallback, `shouldCompact`), `compaction-summary.ts` (deterministic summary from digests and requests; byte cap; model summary prepended when present).
- Store: `usage.lastInput` booked per turn; `contextReset` set and cleared.
- E2E matrix (fake Claude, Codex, ACP, pi): the fake reports growing input tokens (new knob `FAKE_*_INPUT_TOKENS` or `OMB_CONTEXT_WINDOW` forced small); after the budget is crossed the next turn shows a compaction chip, a fresh session (Claude dump: new prompt carries "[Summary of the conversation before this point"), and the reply still knows the earlier facts (ACP echo shows the replay).
- Local: side-by-side app build; scorecard T5 on main and branch, one after the other; numbers recorded under `docs/bench/scorecard/`.

## Acceptance

- T5 input tokens at turn 10 on the branch are lower than on main on Claude Code, with all ten replies still correct.
- Every existing suite green; typecheck, lint, i18n clean.
- No behaviour change on threads that stay under budget (T1–T4 numbers unchanged within noise).
