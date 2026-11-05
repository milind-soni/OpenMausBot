# Routine steps and the plan card

Status: approved by Omkar in chat on 2026-11-05 ("design straight and build it"). Desktop and server only; the phone
apps follow in SupaMaus/mausbot-mobile.

## Why

A routine today is one bot running one prompt on its own model. A job like "every weekday at 08:00, Research finds
three AI news items, Chief writes a five-line summary, tell me only if it mentions a release" runs as one long turn
on one bot, usually the Chief on its biggest model, which then hands work off and reads everything back. That is
slow, costs the big model's price for grunt work, and the person can't see what the bot understood before it runs.

Omkar wants two things:

1. **Show the plan after chat creates a routine.** The person sees who does each step, on which model, and what ends
   the run early. Editing stays in chat ("make step 2 use the quick model"). There is no canvas and no form for steps.
2. **A different bot and model for each step**, chosen to fit the task, passing context between steps without paying
   for whole transcripts.

## Goals

- A routine can have 2 to 6 ordered steps. Each step names a bot, its instructions and optionally the bot's quick
  model. A step can be a yes/no check on the previous step's reply.
- Each step runs in a fresh thread of its bot, so no step pays for an earlier conversation.
- Only the previous step's reply crosses to the next step, redacted, fenced and cut to 4,000 characters.
- Check steps and grunt steps can run on the bot's quick model (Haiku, Flash, mini and the like).
- In chat, the live card for a created routine shows the plan, and the latest run's progress per step.
- One run is still one run. Run history, failure streaks, week totals, retries, restart recovery and the single
  result line in the results chat all keep working as they do today.

## Non-goals

- A visual node editor or canvas, on any platform.
- Branches that run different steps on yes and no, loops, or parallel steps. A check only gates: yes goes on, no stops.
- Exact model ids per step. `quick` or the bot's own model only. Exact models need `list_models` (PR #3920) first.
- Steps on room-goal routines, or routines with `checks`, `access` or `deliver: brief` (the proactive watch). Those
  keep one prompt.
- Phones in this branch. They receive `steps` and `stepRuns` over the existing wire and render them in a follow-up.

## Anti-goals

- A plain routine (no `steps`) behaving differently in any way. Its prompt, its catalog bytes aside, its run and its
  report must be byte-for-byte what main does today.
- Losing a routine's steps on undo, on an edit from the form editor, on restart or in a workspace backup.
- One run per step. That breaks week totals, failure streaks, continuity, run cards and run ids (see
  "Alternatives").

## Data shape

Shared types are in `shared/routines.ts` (`RoutineStep`, `RoutineStepRun`, `ROUTINE_STEP_LIMITS`, `Routine.steps`,
`RoutineInput.steps`, `RoutineRun.plan`, `stepAt`, `stepRuns`, `handoff`). `server/routines.ts` keeps its own
`Routine` and `RoutineRun` interfaces and must gain the same fields.

```ts
interface RoutineStep { botId: string; instructions: string; model?: "quick"; check?: true }
interface RoutineStepRun { status: "pending" | "running" | "done" | "skipped" | "failed"; threadId?: string;
  model?: string; answer?: "yes" | "no"; startedAt?: number; finishedAt?: number; cost?: number | null }
Routine.steps?: RoutineStep[]            // absent: one prompt, as today
RoutineRun.plan?: RoutineStep[]          // snapshot taken when the run is queued
RoutineRun.stepAt?: number               // index of the running step
RoutineRun.stepRuns?: RoutineStepRun[]   // one per plan entry
RoutineRun.handoff?: string              // last finished step's reply, for the next step only; cleared at the end
```

Rules, enforced where the routine is created or updated (tool and REST):

- 2 to 6 steps. Instructions 1 to 4,000 characters. The first step is not a check.
- Every `botId` is a bot the routine's owner may hand work to (reuse the check `coordinate_bots` applies to its
  target). Unknown, hidden or out-of-team bots are refused with a sentence the model can act on.
- Steps are refused together with `target: "room-goal"`, `checks`, `access` or `deliver`.
- `routine.prompt` stays required. For a stepped routine it is the routine's purpose, the sentence the card shows.
  The steps run instead of it.

## How a run walks its steps

One `RoutineRun` drives every step. `run.botId` stays the routine's owner: results chat, notifications, continuity,
owner notices and removal all keep keying off it. The running step's bot is `plan[stepAt].botId`; add one helper
(for example `runningBotId(run)`) and use it wherever the manager or its host acts on the turn itself:
`targetState`, `createTask`, `startTurn`, `interruptTurn` (cancel and stop), and the `task.routineRunId` stamp in
`syncRoutineRunToSource` (server/index.ts), which today looks the thread up under `run.botId`.

1. **Queue.** `routineRunDefinition` copies `steps` to `plan` and sets `stepAt: 0` and every `stepRuns[i]` to
   `pending`.
2. **Dispatch** (`tick`). For a plan run: skip `joinConversation`, create a fresh task on the step's bot, and pass
   the step's model (below) to `store.createTask` in the host's `createTask`. Record `stepRuns[stepAt]` as
   `running` with `threadId`, `startedAt` and the model's picker label. Start the turn with the step prompt
   (below). The interval window and weekday check apply to step 0 only.
3. **Finish a step** (`handleRuntimeEvent`, the ok `turn.completed` branch, when nothing is pending on teammates).
   Save the step's reply (the last `assistant_text` of the turn, redacted, cut to `ROUTINE_STEP_LIMITS.handoff`)
   as `handoff`, add the turn's cost to `stepRuns[stepAt].cost`, mark it `done`.
   - **A check step.** Read the reply's last non-empty line. `YES` (any case, optional trailing punctuation) is yes,
     `NO` is no. Anything else fails the run: "Step N didn't answer yes or no". Yes goes on like any step. No marks
     every later step `skipped` and completes the run with `report: { state: "quiet" }`.
   - **More steps left.** `stepAt += 1`, `status: "queued"`, clear `threadId`, `startedAt`, `deferredAt`,
     `deferredNoticeAt`, `retried` and `attention`, and let the microtask tick dispatch it. Each step gets its own
     one retry and its own `timeoutMinutes`.
   - **Last step.** Complete the run as today. If the last step that finished was a check, point `run.threadId` back
     at the last non-check step's thread first, so the result line quotes that reply and never "YES". Set
     `run.output` to that reply (2,000 characters, as today) and clear `handoff`.
4. **Fail a step.** The run's existing failure path applies (one retry, then failed). Mark the step `failed` and
   every later step `skipped`. A retry reruns the same step in the same thread.
5. **Restart.** The constructor already requeues a running run once with the same `threadId`. That reruns the
   current step; `stepAt` and `handoff` are on disk.
6. **Find the run.** `runForThread(threadId)` must also match any `stepRuns[i].threadId`, so every step thread keeps
   its routine identity (dreams, memory capture and line labels skip routine threads).
7. **Report.** In the turn-settle path (server/index.ts, `automationReports.runSettled(routineRun, completedTurnId)`),
   pass the turn id only when `routineRun.threadId === event.threadId`. Otherwise pass none, so `replyOf` reads the
   last reply in `run.threadId`. `runSettled` returns early when the run already has `report.state === "quiet"`, so
   a no from a check posts nothing.

### The step prompt

Reuse `composeExecutionPrompt` with the step text as its prompt. Attachments and the continuity carry go to step 0
only. The step text:

```
Step {n} of {total} of the routine "{name}". The routine's purpose: {routine.prompt, cut to 500 characters}
Your part: {instructions}
<previous-step from="{previous step's bot name}">
{handoff, fenced and defused the way <previous-run> is}
</previous-step>
{not last}  Reply with your result only. Your reply goes to the next step, which sees nothing else from this chat.
{last}      Your reply is the routine's result.
{check}     Answer the question with YES or NO alone on the last line.
```

Step 0 has no `<previous-step>` block.

### The quick model

`model: "quick"` resolves when the step's task is created, in the host's `createTask`:
`fastModelFor(catalog, botModel, refused)` from server/turn-route.ts with the same catalog and refused set
`routeDirectTurn` uses, then `checkedModelSelection` and `validateModelProposal` (server/index.ts). If there is no
quick model, the engine refuses small models (Codex on a ChatGPT plan), or validation fails, the step runs on the
bot's own model and `stepRuns[i].model` says which ran. A quick model never fails a run.

## Where the token savings come from

- A fresh thread per step: no step reads another conversation's history.
- Only the previous reply crosses, capped at 4,000 characters (about 1,000 tokens), never a transcript, never a
  coordinator resume over the owner's whole chat.
- No orchestrating turn: the server walks the steps, so no big model reads every reply back to decide what's next.
- Check steps and grunt steps on the quick model: Haiku 5.5 lists at $0.10 per million input tokens against
  Opus 5 at $5 (server/model-prices.ts).

What each step still pays: the bot's system prompt and tool catalog (about 42 to 70 KB), with a cold cache on a
fresh thread. A tool-free text call (`instance.generateText`) would skip that for checks. It needs a second way to
finish a run, and ACP engines lack it, so it is left for later.

## Bot tools

`trigger` (server/drivers/agents-catalog.ts `TRIGGER_FIELDS_SCHEMA`) gains `steps`: an array of
`{ bot?: string, do: string, quick?: boolean, check?: boolean }`. `bot` is a teammate's name or id, defaulting to the
calling bot. On `update`, `steps` replaces the whole list and `steps: []` removes it. Keep the description short:
every bot pays these bytes on every turn. Regenerate the catalog goldens and, if the size test's 2% allowance is
exceeded, raise `BUDGET_BASELINE` in the same commit and say why.

`trigger_info` lists a routine's steps (bot name, instructions, quick, check), so a bot can edit them from chat.

The routine request path must carry `steps` through every stored shape: the tool-input and stored zod schemas
(`server/routine-request-schemas.ts`, all `.strict()`), `inputFromDefinition`, `updateFromChanges`,
`effectiveDefinition`, `routineSnapshot`, `restorePatch`, the duplicate check in `revalidateOperation` and
`sanitizeInput` (server/routine-input.ts). Undo after an update or a delete restores the steps. The card's English
`subtitle` lists the steps, one line each. REST `PATCH /api/routines/:id` from the form editor leaves `steps` alone
unless it sends them.

## The plan card

`src/components/RoutinePlan.tsx` draws a routine's steps as a numbered list:

- the bot's avatar and name, and "quick model" or the model the last run used;
- the instructions, clamped to two lines;
- a check step reads "Only if: {question}";
- with a run, each step's state: done, running, skipped or failed.

It reads the routine and its newest run from the store, so it stays live. It renders:

- inside `TriggerCard` (the card a created routine leaves in chat) when the routine has steps;
- under the `AppliedChangeLine` of an update whose changes include `steps`, so an edit in chat shows the new plan
  where it happened;
- in `AutomationPanel`, above the run list.

All copy is i18n (`src/locales/en.json`, plain words per `src/locales/everyday-words.test.ts`, then
`npm run i18n:check`). Run states reuse existing keys where they fit.

## Phones (follow-up, SupaMaus/mausbot-mobile)

`steps` rides `GET /api/routines` and the `routine` frame. `stepRuns` rides `routine.run`. Both apps draw the same
list under the routine card. No server change is needed for them.

## Alternatives considered

| Shape | Verdict |
| --- | --- |
| One run drives the steps, `threadId` follows the running step | Chosen. Run history, streaks, retries, restart and the single report keep working. |
| One run per step under the routine | Rejected. Week totals, failure streaks, repeat-notice suppression, continuity, the 5-newest run window and run ids all assume one run per occurrence; a later step's success masks an earlier failure. |
| An in-memory step loop on `onSettled`, like room goals | Rejected. Not restart-safe; room-goal runs already fail on restart and are never retried. |
| Checks as tool-free `generateText` calls | Deferred. Cheaper per check, but it needs a second way to finish and report a run, and ACP engines lack it. |
| A canvas or form editor for steps | Rejected by Omkar: editing stays in chat. |

## Tests the builder must leave

- Manager: a 3-step run walks bot A, then bot B, then a check; each step gets a fresh thread on its bot; step 2's
  prompt holds step 1's reply and nothing from step 1's thread beyond it; the report quotes step 2, not "YES".
- A check answering no completes the run quietly, marks the rest skipped and posts no line.
- A check answering neither fails the run.
- A failure in step 2 retries step 2 once in the same thread, then fails the run with step 3 skipped.
- A restart during step 2 reruns step 2, and its prompt still holds step 1's reply.
- Cancel interrupts the running step's bot, not the owner.
- `model: "quick"` creates the step's task on the quick model, and falls back to the bot's model when there is none.
- A plain routine's prompt and report are unchanged (an existing test covering it must stay green untouched).
- Requests: create with steps, update steps, undo restores the previous steps, delete then undo keeps them; refusals
  for 1 or 7 steps, a first-step check, an unknown bot, and steps with `checks`.
- An e2e run on the fake engine with two bots, in the style of `server/routine-delegation.e2e.test.ts`.
- Client: `TriggerCard` shows the plan for a stepped routine and none for a plain one; step states follow the run.
</content>
</invoke>
