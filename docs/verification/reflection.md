# Reflection into candidate skills (Phase 4 part 3)

What it proves: a board task judged complete that took real tool work leaves one candidate
skill for a person to review — staged through the same store as `/learn`, with a review card
in the task's run thread — and never enables anything on its own. (The import lock the
roadmap asked for already exists: source and SHA-256 are pinned at import, enablement is
refused when the stored bytes change, and the listing says so.)

- Unit: `server/reflection.test.ts` — the rule (judged complete, three or more tool steps),
  the prompt, the strict parse (NONE, prose, a missing or empty section all refused; the name
  becomes a kebab id; the SKILL.md gets front matter).
- End to end: `server/reflection.e2e.test.ts` (fake engine scripted with three tool calls) —
  one staged candidate named after the task with the four sections in its preview, one review
  card in the run thread; the same task again stages nothing new.

Config: `learn.reflect` (default on; off when skill authoring is off). One harness call per
qualifying task, fingerprinted per task and attempt. Deferred: usage counters on learned
skills (no reliable signal until file reads are brokered), `run_code → save_skill → run_skill`
and the offline mini-benchmark.

By hand: file a board task for a bot with a working folder that needs a few tool steps; after
"Verified: complete", open the run thread — a "Learned skill" card shows the draft; enable it
or not. Ask the bot to do the same task again: no second card.
