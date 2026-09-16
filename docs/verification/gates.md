# Gates and scoped claims (Phase 3 part 1)

What it proves: when a board task's turn ends in a project folder, the harness runs that
folder's checks itself and the task says what ran. A bot's "done" is no longer only a sentence.

- Unit: `server/gates.test.ts` — discovery precedence (`.openmausbot/gates.json`, then
  `package.json` scripts typecheck → lint → test → build through the lockfile's package manager),
  runs that record pass / fail / timeout with the output tail and never stop at the first
  failure, and the scope line ("Gates: typecheck pass (12 s), test fail (30 s); build not run.").
- Board: `server/task-board.test.ts` — a gate run is kept on the task and survives a reopen.
- End to end: `server/gates.e2e.test.ts` (fake engine) — a task whose bot works in a folder with
  a failing `test` script reaches review with `gates` = typecheck pass, test fail; its result is
  prefixed with the scope line; a comment carries the failing tail; a folder with no scripts
  gets neither.
- Prompts: `SCOPED_CLAIM_PROMPT` rides on the board task prompt and the routine execution
  prompt (`server/system-prompt.test.ts`).

Config: `gates.auto` (default on; `false` discovers but never runs), `gates.timeoutSeconds`
(default 600). Direct chats never run gates.

By hand: give a bot a working folder that has `package.json` scripts, file a board task for it
with the bot on "Approve for me", wait for review, then ask "what is on the board?" — the
`task_list` line under the task reads `Gates: …`, and the task's comments carry the failing tail.
