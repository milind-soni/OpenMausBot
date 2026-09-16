# Freshness and consolidation (Phase 4 part 2)

What it proves: a bot's notebook stays honest without a person editing it — restated facts are
stamped confirmed, duplicates merge, contradictions are struck with a trace, stale
low-importance lines move to an archive, never more than a fifth of the file per pass, and the
journal can undo any pass.

- Unit: `server/consolidate.test.ts` — parsing dated entries, the confirmed stamp, the plan
  (duplicates onto the newest, the contradiction's loser, stale lines, the floor, importance 5
  and confirmed lines never stale), applying the plan, the contradiction prompt and its parse.
- End to end: `server/consolidate.e2e.test.ts` (fake engine) — seeded notebook, three passes.
- Capture: `server/capture.e2e.test.ts` — a fact said again stamps its line as confirmed.

Routes: `POST /api/bots/:id/memory/consolidate` → `{ ok, entries, removedDuplicates,
superseded, archived, overFloor, judged }`. Config: `memory.staleDays` (90),
`memory.consolidateHour` (3). Every pass is one journal entry with `via: consolidate`.
