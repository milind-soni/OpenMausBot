# Harness recall (Phase 1 part 2) — how to see it and how to measure it

What it is: before a direct turn, the harness searches the bot's own memory
files, its other conversations (rooms included) and SupaMaus captures with
the user's message and puts the best passages in front of the message as a
numbered block. The bot is told it is reference material, not instructions,
and asked to end its reply with one `Sources: [n]` line when it used one.
No model call; every engine.

## By hand, in the app

1. Settings → Appearance → turn on **Tool calls** (chips are hidden otherwise).
2. On a bot, say: *Remember this for later: our deploy password hint is
   'blue-falcon-42'. Reply with just OK.*
3. Open a **new task** on the same bot and ask: *What is our deploy password
   hint? Reply with the hint only, without running any tools.*
4. Expect: a chip **recalled 1 conversation** before the reply (expand it to
   see the source's thread and message ids), the right answer, and, when the
   bot cited its source, the chip reads **· used [1]** and the reply carries
   no `Sources:` line (the harness moved it onto the chip).
5. Put a fact in the bot's memory (Settings → Memory) and ask about it in
   another new task: the chip says **recalled 1 note**.
6. `GET /api/metrics` shows `recalls` and `recallsUsed` per bot and engine.

Off switch: `recall.auto: false` in `config.json`. Captures off:
`recall.captures: false`. Block size: `recall.maxChars` (default 9000).

## Unattended: the scorecard's T6 and the recall set

```sh
OMB_DATA_DIR=$HOME/.openmausbot-score OMB_PORT=28801 \
  node --experimental-strip-types server/index.ts &

# T1–T6 (T6 = told in one thread, asked in a new one)
node --experimental-strip-types scripts/bench/scorecard.ts \
  --url http://127.0.0.1:28801 --data-dir $HOME/.openmausbot-score --label branch --skip-long

# the 24-case recall set (docs/bench/recall-set.json)
node --experimental-strip-types scripts/bench/recall-set.ts \
  --url http://127.0.0.1:28801 --data-dir $HOME/.openmausbot-score --label branch --out /tmp/recall-branch.json
```

Before a measurement run, write `{"recall":{"captures":false}}` to the score
folder's `config.json`: a harness started standalone on a Mac that runs
SupaMaus would otherwise read the person's real capture token and recall
their own captures into the test bots' turns (finding F14). Run the same
against a `main` worktree on its own port and data folder, one after the
other, never at the same time. The numbers to compare: the recall
set's **passed N/24** and **asking turns with tools** (a bot that has to
search by hand takes tool steps; a bot handed the passage does not), and
T1–T5, which must not move. Records live under `docs/bench/scorecard/`.

## What the tests prove

- `server/recall-block.test.ts`: the block's shape, caps, fence safety and
  the Sources line.
- `server/recall.test.ts`: which sources are searched and labelled, and the
  "recently" section on a fresh session.
- `server/recall.e2e.test.ts`: on the fake Claude, Codex, ACP and pi engines,
  a new task's turn carries the memory and conversation passages; the chip,
  the usage row and the metrics agree; the Sources line moves to the chip;
  the off switch and the eight-character guard hold.
- `server/supamaus.test.ts`, `server/harness-calls.test.ts`,
  `server/memory-importance.test.ts`: the capture source, the fingerprinted
  harness calls, and the importance grammar.
