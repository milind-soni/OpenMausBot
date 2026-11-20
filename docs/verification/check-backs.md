# Check-backs: a bot comes back later by itself

A bot calls `check_back` with a time and a note; at that time it takes a turn in the same
conversation with the note. See [Routine schedules](../routine-schedules.md#check-back-later).

## Automated checks

```sh
pnpm exec vitest run server/host/check-back-time.test.ts server/host/check-backs.test.ts server/routes/check-backs.test.ts src/components/CheckBackLine.dom.test.ts
OMB_TEST_PORTS=20900-20999 pnpm exec vitest run server/check-backs.e2e.test.ts server/cloud-team-check-backs.e2e.test.ts
```

Unix sockets cap their path near 104 bytes: run the e2e tests with a short `TMPDIR`.

- `check-back-time`: spans, exact times, days and times in a zone, a skipped and a repeated
  wall-clock hour, refusals.
- `check-backs`: fires once at its time with nobody asked and the asker's origin; limits;
  restart and catch-up once, late; a start cut by a stop is never run again; cancel; a gone
  conversation, bot or person drops it; a busy chat waits; a refused start is retried.
- `check-backs.e2e`: on a fixture with the fake engine, a turn sets two check-backs, Cancel
  stops one, and a minute later the same bot is woken in the same conversation with the note
  and no card; that turn sets the next one.
- `cloud-team-check-backs.e2e`: on a Team Cloud, Ben's private chat sets one; it runs there for
  Ben's request (`origin.person` is Ben's key) and Cleo, the owner, never reads it.

**What it does not prove:** what a real model does with the note, and phones (they show the
line's English words).
