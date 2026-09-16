# Phase 3 part 3 — the verifier and the loop breaker

## The problem

After part 1 the harness knows what the checks said, but nothing judges the work against what
was asked. A bot's result is its own word. And a bot stuck repeating the same failing tool call
is only watched (a chip at 5, 10, 20), never stopped.

## The verifier

**One tool-less model call** (`server/verifier.ts`) when a board task's turn ends and its gates
have run: the acceptance text (the task body), the result digest, the gate results with failing
tails, and the bot's own last words from the run. Strict JSON back:
`{is_complete, confidence, evidence_for, evidence_against, next_action}`. A parse failure is
"not complete" with the reason. A failed gate caps the verdict at "not complete" whatever the
model says: the checks are ground truth.

**Where it runs.** Through `runHarnessCall` on the assignee bot's own engine (fingerprinted per
task and attempt, budget-checked, booked to the task like any turn). `verify.auto` (default on),
`verify.retries` (default 1).

**What it does with the verdict.** Stored on the task (`verdict_json`, `verdict_at`), one
comment with the line (*Verified: not complete (confidence 0.35) — … Next: …*), shown by
`task_list` and the board screen. **Not complete and retries left**: the task goes back to
`ready` and the next attempt's prompt starts from the verdict (what was missing, what to do).
**Not complete and no retries left**: the task stays in `review` for a person, with the verdict.
**Complete**: stays in `review` with the verdict; a person marks it done. A bot still has no
route to mark a task done, so a task cannot finish on a bot's word.

## The loop breaker

Where the harness brokers the call (the agents proxy: every peer, board, room, memory and
connector tool), identical calls that keep failing are counted per call key: the 3rd identical
failing call gets a warning appended to its error ("this is the third identical failing call —
change approach or say what is blocking you"); the 5th is refused without running. A success on
that key resets it. Engine-native tools (Bash, file edits) are only counted, as before; the
chip remains at 5, 10, 20, and the nudge through steering on engines that support it is a
follow-up with #233's shape.

## Engines

Verifier: full on every engine (a one-shot call on the bot's own engine; where an engine has
no one-shot path the verdict is "not run" and the task stays in review). Loop breaker: full for
proxy-brokered tools on every engine; native tools counted only.

## Measured

`server/verifier.test.ts` (prompt contents, strict parse, fence tolerance, unreadable → not
complete, gate override, the line); `server/task-board.test.ts` (verdict stored);
`server/task-dispatch-bot.test.ts` (a retry's prompt carries the verdict);
`server/verifier.e2e.test.ts` (fake engine): a task whose body carries `[[fake:incomplete]]` is
judged not complete, sent back to ready once, run again, judged again and left in review with
attempts 2 and the verdict; a plain task is judged complete and stays in review; the proxy suite
proves the 3rd-call warning and the 5th-call refusal.
