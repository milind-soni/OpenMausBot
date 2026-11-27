# Bot concurrency: fan-out membership, serialized turns, queued wakes

Status: decision record (Sep 2, 2026). Scopes the "parallel runtime" part of
`2026-08-22-channels-plan.md` against how Grok Bot actually behaves.

Update (Sep 9): the direct-conversation decision below is superseded by
[independent threads and projects](2026-09-09-independent-threads.md).
The earlier audit remains useful history; multi-bot channel turns still use
the conservative per-bot lane described here.

## What Grok Bot does (verified against docs.x.ai/grok-bot and hands-on reports)

- **Membership fans out.** One bot can sit in many group chats; xAI's own guide reuses the same
  Coder/Researcher/Writer across project channels. Bots are personas, not copies.
- **Execution is serialized per bot.** A bot has one conversation and one *current turn*. A user DM
  "takes priority over background work and can redirect the current turn"; "Stop now" ends it.
  Bot-to-bot messages are asynchronous *wakes* ("the receiving Bot wakes, handles the request, and
  can reply later"). In a group, "the host wakes each member in turn". There is no queue UI and no
  second lane: messaging a busy bot redirects it.
- **Parallelism comes from more bots.** Every parallel claim in the docs is plural ("several Bots
  can work at the same time… each gets its own screen"), never one bot doing two things. One
  computer-use task per screen at a time; one shared computer per user (not a security boundary).
- **Routines are wakes on the owning bot's lane** (they run in that bot's conversation context —
  xAI staff recommend a dedicated routine bot so schedules don't queue behind a long chat turn).
- Memory is per bot, files per user; no concurrent-write semantics are published — the product
  pushes conflicts to "a single owner at each stage".

## Decision for OpenMausBot

1. **Default stays serial per bot; membership fans out; a busy bot is *woken later*, never
   skipped.** Ordinary room turns join the same bounded wait that goals use (`waitForGroupGoalBot`
   → a shared member wait): a responder busy elsewhere takes its turn when it frees, with a visible
   "finishing another conversation" note; past the wait cap the round moves on with a chip that says
   so. Stop on the room releases the wait. This closes the "busy member → skipped/failed" fragility
   for chat rooms the way #702 closed it for goals.
2. **A user's DM outranks background work** (Grok Bot's rule): the steer queue already holds it for
   the next settle; Stop remains the redirect.
3. **Parallel turns for one bot are an explicit opt-in, not the default** — the channels plan's
   turn-lease design (`maxConcurrentTurnsPerBot > 1`, exclusive leases on the bot's computer and any
   shared working folder, single-writer memory) stays the follow-up (PR 3/4 of that plan), gated on
   driver conformance and off by default. The UI must never promise parallel work for a serialized
   driver or resource.

## Prerequisites before any opt-in parallelism (from the codebase audit)

- `unattendedBots` is keyed per bot on the stated assumption of one turn at a time. Under two live
  turns an attended chat turn would clear a concurrently running webhook turn's unattended mark and
  hand it auto-approve. Rekey it per thread first — a privilege fix, not a UX one.
- `MEMORY.md` writes go through the atomic temp→rename helper (#703); a per-bot single-writer path
  is required before two turns of one bot may both "remember".
- The 409 text "already working" is string-matched as control flow in three retry paths (delegation
  wake, connector resume, secret resume). Introduce a typed error code before changing any gate.
- Stop routing (`activeGroupTurnForBot`) is a first-match scan; it must resolve by (bot, thread).
- Drivers need no work: Claude, Codex and every ACP driver already isolate turns by thread.

Open product question: a turn parked on a human's approval card (`waiting-on-you`) counts as busy.
Under a per-bot lane count it would consume a slot; the UI must say so or "1 of 2 busy" reads as a bug.

Sources: docs.x.ai/grok-bot (bots, chat-and-collaboration, computer-and-apps, faq, overview,
skills-routines-and-automations, teams-and-enterprises), x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots,
brianlovin.com (first impressions), flaviocopes.com/grok-bot (Matt Palmer), cursor.com/docs/grok-bot.
Comparison: Buzz (one prompt in flight per channel, agents × channels sessions), OpenClaw (per-session
lane, `maxConcurrent` across sessions, steer/followup/collect/interrupt), Hermes kanban
(`max_in_progress_per_profile`), Claude Code agent teams (one teammate = one process, one task).
