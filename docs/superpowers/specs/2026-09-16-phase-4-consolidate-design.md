# Phase 4 part 2 — freshness and consolidation

## The problem

Captured facts are the first to go stale, and a notebook that only grows fills its budget
with duplicates, corrections that were never struck, and details nobody restated in months.

## What is built

**Freshness.** When capture sees a fact the notebook already holds, the existing line is
stamped `· confirmed YYYY-MM-DD` instead of being silently dropped. The stamp is a trailing
mark like #1040's `· updated`, so every existing reader of the grammar keeps working.

**One bounded pass** (`server/consolidate.ts`, pure; `consolidateMemory` in the server):
1. collect: parse the notebook's dated entries; struck lines and hand-written lines are left alone;
2. dedupe: exact duplicates by normalised body merge onto the newest line, the older ones removed;
3. contradictions: one strict-JSON call on the bot's own engine over the numbered bodies
   returns pairs that cannot both be true and which to keep; the loser is struck with
   `· superseded <date>` (#1040's trace), never deleted; an unreadable answer means no pairs;
4. stale: lines older than `memory.staleDays` (90) with importance 1–2 and no confirmation move
   to `memory/archive.md`, each stamped `· archived <date>`;
5. floor: never more than a fifth of the live entries change in one pass; the pass says
   `overFloor` and the next pass continues;
6. apply with the hash check (`writeMemoryDoc` with `expectedHash`: a turn that wrote meanwhile
   makes the pass refuse, nothing applied) and journal one entry (`via: consolidate`) with the
   full before and after — the journal's revert is the snapshot.

**When.** Nightly at `memory.consolidateHour` (3) for bots with capture on; on demand for any
bot through `POST /api/bots/:id/memory/consolidate`, which answers the summary.

## Engines

Full on any engine with a one-shot; without one the pass still merges duplicates and archives
stale lines and reports `judged: false`.

## Measured

`server/consolidate.test.ts` (parsing, the stamp, the plan's four steps and the floor, applying);
`server/consolidate.e2e.test.ts` (fake engine: a seeded notebook of ten entries — the first pass
removes the duplicate and strikes the contradiction's loser and stops at the floor, the second
archives the stale line, the third is idle; the archive file and the journal entry exist);
`server/capture.e2e.test.ts` extended (a restated fact stamps the line as confirmed).
