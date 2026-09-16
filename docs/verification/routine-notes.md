# Routine notes (Phase 4 part 4)

- Unit: `server/routines.test.ts` — `extractNextRunNote` reads "Note for next run:" in plain and
  bold forms; a bot's proposal of an enabled twin (same bot, instructions and schedule) is refused
  with its name and next time, a person's is not, a different schedule is not, and the refusal
  lifts once every twin is off.
- End to end: `server/routine-notes.e2e.test.ts` — the note lands on the run (`nextNote`) and in
  the next run's prompt as `<previous-run-note>`, never in the first run's.

By hand: give a routine instructions that end with "…and end with a line 'Note for next run:'
saying what to skip next time"; run it twice; the second run's thread shows the note in its
first message. Ask the bot to schedule the same routine again; it answers that it is already
scheduled and names it.
