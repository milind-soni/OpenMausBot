# Phase 4 part 3 — skills that learn

## What was already there

The import lock the roadmap asked for exists: every imported or learned skill records its source
and the SHA-256 of its SKILL.md (#428, #656), enablement is refused when the stored bytes no
longer match, and the listing says so ("stored SKILL.md changed after review — enablement is
blocked"). Nothing to add; recorded here so nobody rebuilds it.

## What is built: reflection

**When.** A board task judged complete (Phase 3 part 3) whose run took at least three tool
steps. Nothing for chats, routines or tasks judged not complete.

**What.** One model call on the bot's own engine (`server/reflection.ts`): the task, what was
asked, the recorded result, the tool steps and the bot's words; back comes either `NONE` or a
draft with a name, a one-line description and a SKILL.md carrying exactly four sections —
When to use, Procedure, Pitfalls, Verification — each non-empty, or the draft is dropped.

**Where it goes.** `stageSkillWrite` (the same store `/learn` uses) with source
`reflection on task "…"`, then the existing review card in the task's run thread and a
decision-log row `card-shown`. A person reads the full SKILL.md on the card and enables it, or
not (decision 8: one human approval, never automatic). A draft whose name already exists as a
skill or as a staged candidate is not staged again.

**Cost.** One harness call per qualifying task, fingerprinted per task and attempt, booked,
refused at the monthly cap. `learn.reflect: false` switches it off; skill authoring off
switches it off too.

## Deferred, with reasons

- Usage counters on learned skills: an enabled skill is read by the engine's own file tools,
  so the harness has no reliable signal that a skill was used. Comes with Phase 5's sandbox,
  where file reads are brokered.
- `run_code → save_skill → run_skill` and the offline mini-benchmark: need the sandbox and the
  counters.

## Engines

Full on any engine with a one-shot; without one nothing is drafted.

## Measured

`server/reflection.test.ts` (the rule, the prompt, the strict parse with the four sections);
`server/reflection.e2e.test.ts` (fake engine: a board task whose run makes three tool calls and
is judged complete leaves one staged candidate and one review card in the run thread; a second
identical task stages nothing new; a task with one tool step stages nothing).
