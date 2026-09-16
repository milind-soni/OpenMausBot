# Phase 3 part 1 — gates and scoped claims

## The problem

A bot's "done" is a sentence. Nothing in the harness runs the project's own checks, and nothing
makes the bot say what it ran. Gap G in the gap analysis; the verifier (part 3) has nothing
decidable to judge against without this.

## What is built

**Gate discovery** (`server/gates.ts`, pure). For a working folder:
1. `.openmausbot/gates.json` if present: `[{ "name": "typecheck", "run": "pnpm typecheck" }, …]`,
   in the order written. This is the declared sequence.
2. Otherwise `package.json` scripts named `typecheck`, `lint`, `test`, `build`, in that order,
   run through the package manager the lockfile names (pnpm, yarn, npm).
3. Otherwise no gates.

**Gate runs** (`server/gates.ts`). Sequential, each a child process in the folder with a timeout
(`gates.timeoutSeconds`, default 600), exit code → `pass` / `fail`, `timeout` on the clock, output
tail kept (last 40 lines, 4k cap). All gates run; one failing does not skip the rest (the claim
needs the whole picture). Result: `GateResult[]` and a **scope line**:
`Gates: typecheck pass (12 s), lint pass (4 s), test fail (2 failed), build not run.`

**Where it runs.** When a board task's turn ends and the task moves to review
(`task-turn-watch` → `setResult`), the harness runs the folder's gates off the turn path, stores
them on the task (`gates_json`, `gates_at`), prefixes the result digest with the scope line, and
adds a task comment with the same line and the failing tails. `task_list` shows `gates: …`.
Direct chats never run gates (a person is reading; cost stays zero). Routines get gates in part 4
as the `check` node.

**The rule in the prompt.** The board task prompt and the routine execution prompt gain one
sentence: when you report finishing, say what you ran and what you did not (typecheck, lint,
tests, build). Text only, every engine.

**Config.** `gates.auto` (default true; off means discover but never run), `gates.timeoutSeconds`.

## Engines

Full on every engine: the harness runs the gates and writes the claim; the prompt sentence is
plain text.

## Not in this part

Gates on direct chats or on `report_progress`; a "run checks" button (part 2 may add it); gates
on routines (part 4); Makefile / cargo / go discovery (add when a project needs it).

## Measured

`server/gates.test.ts` (discovery precedence, package-manager choice, the scope line, a timeout);
`server/gates.e2e.test.ts` on the fake engine: a task in a temp repo whose `test` script exits 1
reaches review with gates `[typecheck pass, test fail]`, the comment and digest carry the scope
line, `task_list` shows it; a repo with no scripts gets neither. T1–T10 unchanged.
