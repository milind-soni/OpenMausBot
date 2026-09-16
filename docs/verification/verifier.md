# The verifier and the loop breaker (Phase 3 part 3)

What it proves: a finished board task is judged against what was asked, the gates and the bot's
own words, by one tool-less model call; a "not complete" verdict sends the task back once with
the verdict in the retry's prompt; a bot cannot finish a task on its own word. And a bot that
keeps making the same failing brokered call is warned at the third and refused at the fifth.

- Unit: `server/verifier.test.ts` — the prompt's contents, strict JSON parse with fence
  tolerance, unreadable → not complete, a failed gate overrides "complete", the verdict line.
  `server/drivers/agents-proxy.test.ts` — the loop breaker's warn / refuse / reset.
  `server/metrics.test.ts` — harness calls counted apart from turns.
- Board: `server/task-board.test.ts` (verdict stored), `server/task-dispatch-bot.test.ts` (a
  retry's prompt carries what was missing).
- End to end: `server/verifier.e2e.test.ts` (fake engine) — a task whose body carries
  `[[fake:incomplete]]` is judged not complete, retried once with the verdict, judged again and
  left in review on attempt 2 with two verdict comments; a plain task is judged complete and
  stays in review. `server/gates.e2e.test.ts` — a failed gate makes the verdict not complete and
  the task is retried once.

Config: `verify.auto` (default on), `verify.retries` (default 1, at most 5). The verifier runs on
the assignee bot's own engine through `runHarnessCall` (fingerprinted, budget-checked, booked
under trigger `harness`, so it shows as a harness call in the metrics, not a turn).

By hand: file a task for a bot on "Approve for me" whose body asks for something the bot cannot
prove (or whose folder has a failing test); after the run, the task's comments carry
*Verified: not complete … Next: …*, the task runs once more with that in its prompt, and ends in
review with the second verdict. Ask "what is on the board?" — `task_list` shows the verdict line.
