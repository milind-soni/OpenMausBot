# Phase 4 part 4 — routine notes

Two small things the roadmap listed, both text conventions so every engine has them.

**A note for the next run.** A routine's run may end its report with one line starting
"Note for next run:" (the execution prompt says so). The harness keeps it on the run
(`nextNote`) and the next run of the same routine, when continuity is on, sees it as a
`<previous-run-note>` beside the previous report — the bot's own words to itself, bounded to
500 characters, secrets redacted.

**Already scheduled.** When a bot proposes a routine (through the confirmed card, i.e. with a
request commit) whose instructions and schedule match an enabled routine of the same bot, the
create is refused with *already scheduled: "<name>" runs these same instructions, next at
<time>. Edit that routine instead of adding another.* A person's own calendar edits are not
refused: duplicating on purpose stays possible.

## Measured

`server/routines.test.ts` (the note line in its plain and bold forms; the twin refusal for a
proposal, not for a person, not for a different schedule, and lifted once the twin is off);
`server/routine-notes.e2e.test.ts` (fake engine: the first run's note is on the run and in the
second run's prompt, not in the first's).
