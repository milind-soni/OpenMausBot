# Native conversation model control

Chiefs can inspect and change an existing task without replacing its conversation,
working folder, files, access settings or native resume cursor.

- `get_thread_model {thread_id?}` reports `botDefault`, `taskOverride`,
  `currentExecution`, and `nextTurn`. Omitting the ID inspects the caller's task.
- `set_thread_model {thread_id, model_selection, reason}` saves the same task
  selection as the app picker. `model_selection` contains `instanceId`, `model`,
  and optionally `effort` or `variant`, never both. Catalog IDs come from
  `list_team_setup`; unadvertised models and thinking choices fail before mutation.
- `propose_model {model_selection, reason, for_bot_id?}` changes a bot's default
  separately. Existing tasks retain their selections. Its receipt identifies
  `scope: bot_default`, and includes the caller's task receipt for a self change.
- A selection mutation never dispatches, resumes or cancels a turn. A busy task
  accepts a **next-turn-only** change; the running execution keeps its captured
  selection. Only an explicitly requested `retry_thread {bot_id, thread_id}`,
  OpenMausBot's one automatic retry of a failed teammate thread, or a new
  message starts work. Both retries refuse an unavailable pinned task engine
  rather than silently running on the bot default; an automatic retry refused
  this way is reported to the Chief as not retried.

Task control requires Chief authority. Chiefs can control their own tasks and
bot-opened tasks they manage. Another bot's person-started task, an automation
run, an inaccessible team/account, an archived bot, and an unknown target fail
closed. Cloud audience checks apply on inspection, mutation, confirmation and
Undo. Existing engine/approval compatibility and organization policy apply;
changing model does not widen permissions.

Native model proposals, confirmations and Undo refuse a saved key while trial
credit holds that engine. Import validates the catalog and organization policy
without treating storage as permission to execute: the held key remains saved,
and the isolated trial lifecycle must prove that the included-credit engine
answers before the saved key becomes eligible.

Applied changes appear in the proposing conversation with **Undo**. Undo
revalidates authority and the previous selection, and refuses a stale card if
the stored override or effective selection differs from the card's applied
result. A newer pin-to-follow or follow-to-pin change invalidates the older Undo
even when the effective model is unchanged. Undo restores an explicit task pin even
when that pin equals the current default; later default changes still leave the
pin alone. Restoring a task that followed its default keeps that behavior.
Selecting the current default clears an explicit task pin, even when today's
effective model is unchanged. Selecting that same model for an already-following
task is a no-op and creates no change card or execution.
An owner-confirmation-required Cloud request remains pending rather than
silently applying. Confirmation checks stored overrides, not just effective
model equality. If default drift would change the requested result between an
explicit pin and following the default, confirmation refuses as stale and leaves
the card unanswered, whether the task previously followed its default or had a
pin. Confirmed task changes are labeled as conversation changes, not default
changes.

Pending thread-model cards share the existing eight-open-proposal budget with
profile, default-model, routine and team-setup requests. Settling a card restores
capacity; immediately applied owner changes do not consume pending capacity.

`currentExecution.model` and `.effort` are native session evidence, or null when
unconfirmed. `nextTurn.resolved` is false: a stored choice is not runtime proof.
In custom ACP, `agent-default` leaves the native session's current model alone;
it does not reset a pooled session to the process-start model. Use an explicit
model ID to switch back to a particular model. Supported canonical effort is
transported through the agent's advertised thought config option and checked
again after model selection, before prompt dispatch. No global role mapping is
changed.

## Isolated proof

```sh
pnpm exec vitest run server/thread-model-control.e2e.test.ts
pnpm exec vitest run server/thread-model.test.ts server/thread-model-requests.test.ts server/model-requests.test.ts server/chief-of-staff.test.ts server/drivers/acp/custom.test.ts server/drivers/acp/custom-model-catalog.test.ts src/components/ApprovalCard.test.ts
pnpm exec vitest run server/model-control-host.test.ts server/one-home-trial-key.e2e.test.ts
pnpm exec vitest run server/cloud-personal.e2e.test.ts -t "shares the pending proposal budget"
```

The end-to-end scenario uses `launchVerificationServer` and `runControlOmb`, a
disposable home/data directory and ports, and the offline
`fake-custom-acp-models.ts` process. It seeds delegated-task provenance only
while that owned server is stopped. No live account, provider, service, task or
GPU job is touched. The fake model names are synthetic protocol fixtures, not
real provider executions.

It exercises quota failure, model/effort selection without dispatch, validation
failure without persisted mutation, cross-team and person-started refusal,
Undo, separate explicit retry with native model/effort receipts, preserved
conversation text and artifacts, self-task/default change and restoration, and
a held running turn whose current model remains unchanged until its next turn.
The fake records settings at `session/prompt`, not merely the saved API alias.
It also retries a persisted pin whose provider is absent: the API must return
409 without a prompt, conversation mutation, or fallback to the available bot
default; only explicit reselection permits the subsequent successful retry.
The persisted-store regressions cover stale confirmation after a default change
and exact Undo restoration across reload and subsequent default changes. They
also cover both pin/follow directions between older and newer cards: stale Undo
leaves persisted selections and cards untouched, while the newer Undo remains valid.
The renderer regressions verify the conversation/default outcome distinction and
that Undo is present before restoration and absent afterwards.

Evidence is written beside the persistent fixture server log as
`*.thread-model-control.json`; the successful fixture removes its disposable
home and stops only its own child. The artifact contains synthetic selections,
API results and ACP receipts, not bearer tokens. These checks are not a live
provider qualification or a packaged desktop/Pi deployment. Independent review
and an idle real-Chief switch-and-back smoke remain release gates.
