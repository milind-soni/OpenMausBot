# Harness scorecard: is the harness getting better?

A short, fixed set of tasks you can run by hand on any build, and the
numbers to write down each time. Run it before and after a change and put
the two rows side by side. This is not the benchmark track
(`docs/bench/2026-09-baseline.md`); it is the everyday gauge.

## The numbers, and what "better" means

| Number | Where it comes from | Better is |
| --- | --- | --- |
| Tokens in / out per turn | the usage ledger (`Settings → Usage`, or `/api/usage`, or `<data>/usage/YYYY-MM.jsonl`) | lower, for the same task done correctly |
| Cached input | same row; the part of "in" the provider re-read from its cache | higher share of "in" on the second and later turns of a thread |
| Cost | same row, as the engine reports it (subscription engines report what it *would* bill) | lower |
| Wall time per turn | a stopwatch, or the `Wall s` column of the script | lower, especially on follow-up turns |
| Steps | tool chips under the reply (needs Settings → Appearance → **Tool calls** on) | fewer for the same result; not zero |
| Correct | did the reply do what was asked (the tasks below have a yes/no check) | yes, always; a cheaper wrong answer is worse |
| Evidence coverage (Phase 0+) | `/api/metrics` → `coverage`; `full` means the harness saw the whole tool result | more `full` |
| Stable-prefix changes (Phase 0+) | `/api/metrics` → `stablePrefixChanges` | lower; each one is a cache miss |

Rule of thumb: compare **the same task, on the same engine and model, on the
same day**. Providers change prices and prompts; the harness is only the part
you can hold still.

## The tasks (run all four, in this order)

Open the app under test, create a fresh bot per task so threads do not mix,
and turn on **Settings → Appearance → Tool calls** so you can count steps.

**T1 — file task (one turn).** Send:
> Create a file called scorecard.txt in your working folder containing
> exactly three lines: alpha, beta, gamma. Then list the folder with ls.
> Reply in one short sentence.

Correct when the reply names `scorecard.txt`. Expect two tool chips. Write
down: in, out, cached, cost, wall time, steps.

**T2 — three follow-ups (one thread, three turns).** New bot. Send, one
after the other, waiting for each reply:
> What is 17 + 25? Reply with the number only.
> Add 10 to that. Reply with the number only.
> Subtract 2 from that. Reply with the number only.

Correct: 42, 52, 50. Write down the numbers for each turn. Turns 2 and 3 are
where a harness that keeps the engine process alive and its prompt stable
shows up: cached input should be most of "in", and wall time should be
lower than turn 1.

**T3 — a big tool result (one turn).** New bot. Send:
> Using one shell loop, write a file named log.txt with 200 lines of the
> form 'line N' (N from 1 to 200). Then print the whole file with cat. Then
> tell me how many lines it has, in one short sentence.

Correct when the reply says 200. On Phase 0 with a Claude bot, open the
`cat` chip: the full 200 lines are there, not a preview, and
`/api/metrics` counts the turn under `coverage.full`.

**T4 — another engine takes over (one turn).** Go back to T1's bot, change
that task's engine (task settings) to a different signed-in engine, then send:
> Which file did you create earlier in this conversation, and what were its
> three lines? Answer in one short sentence without running any tools.

Correct when the reply says `alpha`. This is the "done when" of Phase 0: the
new engine is told what the old one *did* (the digest), not only what it
said.

**T5 — a long thread (ten turns, one thread).** New bot. Send ten times,
waiting for each reply:
> Append 100 lines of the form 'entry N' (N continuing from where the file
> ends, starting at 1 if it does not exist) to log.txt with one shell loop,
> then print the whole file with cat, then reply with only the total number
> of lines in the file.

Correct when turn *n* replies 100 × *n*. Write down "in" for every turn and
the total. This is where context growth shows: without compaction, "in"
climbs every turn as the printed file and the earlier turns pile up; with
harness compaction (Phase 1) a "context compacted" chip appears once the
budget is crossed and "in" drops back on the next turn. The two numbers to
compare between builds are **input at turn 10** and **total tokens over the
ten turns**. The script prints both.

**T6 — recall (two threads, one bot; Phase 1 part 2).** New bot. Send:
> Remember this for later: our release codename is 'blue-falcon-42'.
> Reply with just OK.

Then open a **new task** on the same bot and send:
> What is our release codename? Reply with the codename only, in one line,
> without running any tools.

Correct when the reply says `blue-falcon-42`. On the branch a chip
"recalled 1 conversation" precedes the reply and the asking turn takes no
tool steps; on main the bot has to think of `session_search` itself. The
fuller measure is the recall set (`docs/verification/recall.md`).

**T7 — a bundled skill (Phase 1 part 3, F3).** Start the harness with
`OMB_SKILLS_DIR=server/testing/skills` (a fixture skill whose trigger word is
`zorblat`). New bot. Send *Please zorblat: what is 2 + 2? Reply in one short
line.* Correct when the reply begins with `quantum-elk`. Then send *And 3 + 3?
One short line.* On the branch the second turn keeps the live Claude process
(the skill body travelled in the turn text, not the system prompt); the
scorecard's "stable prompt sections that changed" line must say none.

**T8 — a project's AGENTS.md.** Make a folder holding an `AGENTS.md` that
says "End every reply with the word ZEBRA." and set it as the bot's working
folder. Send *Say hello in one short line.* Correct when the reply ends with
ZEBRA, on every engine (Codex reads the file itself; the harness hands it
to the others).

**T9 — the command filter, off and on (closes F5's gate).** Two bots whose
working folder is a git checkout with a long history, one with
`commandFilters: false`, one with `true`. Send *Run exactly `git log` with no
flags in this folder, then tell me the subject line of the newest commit.*
Compare "in" between the two; the script prints both.

**T10 — a standing rule across a compaction (Phase 1 part 4).** New bot. Send
T5's growing-file message twelve times, but start the first one with *For
this whole conversation, begin every reply with the word LANTERN. Then:*.
Correct when every reply starts with LANTERN and gives 100 × n. On the branch
the turn after the "context compacted" chip carries a restated first request
(no chip; it is in the turn text), so the rule survives the compaction.
`context.recite: false` turns it off, for comparison.

## Doing it unattended

The script runs the tasks above (T6 unless `--skip-recall`; T7–T9 unless `--skip-prefix`, with `--repo DIR` for T9; T10 with `--only-goal`) and prints the same table:

```sh
# 1. start the build's harness standalone on its own port and data folder
#    (the desktop app refuses scripted sends, on purpose)
OMB_DATA_DIR=$HOME/.openmausbot-score OMB_PORT=28801 OMB_SKILLS_DIR=server/testing/skills \
  node --experimental-strip-types server/index.ts &

# 2. run the scorecard (Claude for T1–T3, Codex takes over for T4)
node --experimental-strip-types scripts/bench/scorecard.ts \
  --url http://127.0.0.1:28801 --data-dir $HOME/.openmausbot-score \
  --label phase0 --engine claude --switch-to codex --out /tmp/score-phase0.json
```

Run it once per build you want to compare (a worktree at `main`, a worktree
at the branch), each with its own port and data folder, and paste the two
tables next to each other. `--engine codex --switch-to claude` runs the set
the other way round. Every turn costs real engine usage: the whole set is
six turns per run.

## Reading a comparison honestly

- One run each is a sample, not a verdict. Providers vary turn to turn by a
  few thousand tokens; look for differences that repeat.
- "In" is dominated by the system prompt and tool schemas the engine sends
  every turn. A harness change that trims the stable prompt shows as lower
  "in" on **every** turn; process reuse shows as higher **cached** on
  follow-ups; digests show as T4 turning from "no" to "yes".
- If T2's later turns are not mostly cached, something is breaking the
  prefix each turn. On Phase 0, `/api/metrics` → `stablePrefixChanges`
  names the section that moved.

## Record

Keep runs in `docs/bench/scorecard/` as `YYYY-MM-DD-<label>.md` with the
table, the engine versions (`/api/instances`), and the commit. The first
pair is `2026-09-15-main-vs-phase0.md`.
