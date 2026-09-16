# Phase 4 part 1 — fact capture at the end of a turn

## The problem

A bot remembers only what it is told to remember (`memory_update`) or what the harness can find
again in a conversation (Phase 1 recall). A fact said in passing — "my dog is called Biscuit",
"we ship on Fridays" — lives in one thread until that thread is archived or compacted away.

## What is built

**Opt-in per bot** (`memoryCapture: true` on the bot; decision 16). Off, nothing changes.

**When.** After an attended direct turn (a person typed; not a routine, board, room or webhook
turn), the turn's person text and bot reply are buffered per thread. The buffer flushes after a
quiet spell (`memory.captureQuietMs`, default 90 s) or ten turns, off the turn path. Nothing
about the turn waits for it.

**Two prompts by speaker (16d).** One call reads the person's words (preferences, facts,
standing instructions, decisions); a second reads the bot's words (only explicit decisions,
verified outcomes, stable facts; never speculation, suggestions, secrets or unverified claims
that an action happened). Each sees only prior messages from the same speaker in the flushed
batch, plus the bot's current notebook so it does not propose what is already there. Strict
JSON back: `[{text, kind, confidence, importance}]`; unreadable means nothing captured.

**Filters.** Confidence under 0.4 dropped; at most 8 per flush; duplicates against the notebook
and within the batch dropped (normalised text); secrets redacted by `updateMemory` as for any
write; the bot's own captures are marked so a reader knows they were not confirmed.

**Where it lands.** ADD-only appends through `updateMemory` with the existing grammar
(`- date · from chat "…", captured · importance N · fact`), so #1040's date, source, budget
refusal and supersede all apply; `, captured` in the source is the `auto` trust tier. Journaled
with actor `harness`. A budget refusal stops the flush and is logged; nothing is consolidated
automatically here (part 2).

**Cost.** Two one-shot calls per flush on the bot's own engine, fingerprinted per (thread,
last message) so a retry never pays twice, booked as `harness` calls, refused when the monthly
cap is reached.

## Engines

Full on every engine with a one-shot call (Claude, Codex, and any driver with `generateText`
or `generate`); a bot on an engine without one captures nothing and its setting says so in the
API (`memoryCapture: "unsupported"` is not stored; the bot's capture is simply skipped and
logged once).

## Measured

Unit (`server/capture.test.ts`): prompt contents by speaker, strict parse and filters, dedupe
against the notebook, the buffer's quiet and count flushes. End to end (`capture.e2e.test.ts`,
fake engine): a bot with capture on learns "Biscuit" from a passing remark and the entry carries
the date, source and `captured`; small talk yields nothing; a board task's turn yields nothing;
a bot with capture off yields nothing. Live: a capture set of five facts told in passing across
threads, threads archived, asked in new threads — main 0/5 (recall cannot see an archived
thread) against branch 5/5; T1–T10 and the recall set unchanged.
