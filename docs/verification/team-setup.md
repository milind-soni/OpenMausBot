# Reviewed Chief team setup

Use an isolated fixture, never the live app or workspace. The deterministic
integration recipe starts its own temporary server and installs only the
repository's fake Claude and fake Codex engines:

```sh
pnpm exec vitest run server/team-setup.e2e.test.ts
pnpm exec vitest run server/bot-deletion-write-failure.e2e.test.ts
pnpm exec vitest run server/team-setup-requests.test.ts server/store.test.ts
pnpm exec vitest run server/index.test.ts -t 'delet|Full and Custom bots'
pnpm typecheck
pnpm lint
```

The integration test retains a `.team-setup.json` evidence file beside its
printed server log, then removes its fixture data. It uses a real active-turn
capability to call the internal tools, not the owner bot-settings API. Model
planning is simulated in this deterministic test; provider authentication and
real-world task quality are not proven by fake engines.

## Sample requests

With Clive elected Chief of Staff, ask:

> Set up Research with Mira, Engineering with Patch, and Growth with Quill.
> Give each a concise specialist role and standing instructions. Use suitable
> models from the connected engines, including different providers where
> available. Show me one combined setup review.

Clive discovers exact engines/models and authorized teams with
`list_team_setup`, then calls `propose_team_setup` once. A review combines all
fields for each bot. New teams must contain a created or moved specialist.
The card explicitly names the new teams and the authority Clive will receive
to coordinate and propose setup changes there. It cannot grant access to an
already-existing unauthorized team. Names are limited to 60 characters and a
Chief to 100 additional teams, matching persistence and owner settings.

After approval, try:

> Move Patch to Growth and change its default model to a suitable model from
> the other connected provider. Keep existing conversations and permissions.

Only the bot default changes, for new threads and group work. Existing
threads retain their models, approval levels and allowlists, including legacy
threads that previously inherited defaults. A provider incompatible with the
current permission level cancels the entire proposal; setup never silently
downgrades or elevates execution permissions. New specialists use Ask and
start with connected apps disabled. Existing peer allowlists remain in force.

For deletion, ask separately:

> Delete Patch. Show me the deletion confirmation first.

`propose_bot_deletion` produces a separate destructive review naming the exact
bot. Existing lifecycle guards reject active work and owned computers before
removal. Bot conversations, memory, instructions and skills are removed;
generated project files remain. The Chief cannot delete itself.

## Assertions and failure boundaries

The deterministic scenario checks unknown models, spoofed caller identity,
coalescing, denial, approval, duplicate decisions, scope grants, default-model
changes, team moves, stale target edits, separate deletion and exactly one
requester continuation per decision, unless the user stops the conversation.
For both direct tasks and rooms it denies while Clive is still running, then
presses Stop and checks that neither a fresh provider generation nor a reply
appears, including after a duplicate decision. It also verifies that forged Origin
headers from an active loopback bot cannot approve setup or deletion. A
trusted desktop or paired owner can review; headless local-browser approval
waits until every bot is idle. Denial is always safe to accept.

Domain and Store tests cover injected permission fields, hidden/unauthorized
targets, peer restrictions, busy/deleted/stale targets and source conversations,
closed cards, the 60-character/100-team boundaries, model incompatibility,
failed writes, receipt replay, and reload preservation of legacy task settings.
Stopping or deleting the requesting conversation does not resurrect its card.

All bot changes, new-team grants and the result receipt use one atomic
`bots.json` write before publishing bot mutations. The separate team registry
is saved first: if the bot write subsequently fails, an empty named team can
remain, but no bot, model, membership or Chief-access changes are applied.
Deletion similarly saves removal and its receipt before deleting bot data.
The deletion write-failure fixture obstructs the exact temporary `bots.json`
destination, exercises the real DELETE lifecycle, and checks that the complete
bot, conversations, routines, webhooks and solo/shared calendar calls are
unchanged in memory and on disk. It restores that fixture file and retries
successfully; unrelated call guests remain. No production fault hook is used.
Later cleanup failure is reported distinctly from a failed/unapplied setup.

## Recorded app and real-model checks — 2026-09-13

The real renderer was driven through `control:omb ui` in an isolated fixture:
Clive's pending card displayed the exact Research/Mira setup and scope grant;
Cancel received initial focus, Apply setup was the sole positive action, and
no Always allow option appeared. Clicking Apply setup created Mira, cleared
the pending composer, showed Team setup applied, and rendered one automatic
continuation. Screenshot and retained log were saved by the verification run.
This checks the shared React review UI, not native desktop packaging.

A separate isolated run with each of **real Codex gpt-5.6-luna** and
**gpt-5.6-sol** received an ordinary-language request (no tool instructions).
Each called `list_team_setup` and
`propose_team_setup` once, proposed exactly Mira/Research, Patch/Engineering and
Quill/Growth using a connected model, then reported success after one approval
without asking again. These are two dated model-following samples, not a guarantee
of every provider or task. The temporary authentication copy and fixture data
were removed after the run; only bounded result evidence was retained.

The combined main-based integration was repeated with real Luna after the
registry/import fixes: exactly one review created all three requested bots with
the selected model and Chief grants, then the Chief continued. Evidence:
`/tmp/omb-live-team-0913.MwRY2k/setup-gpt-5.6-luna-1789255036346/result.json`.
