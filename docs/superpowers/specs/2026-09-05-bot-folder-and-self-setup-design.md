# Bot instructions, setup by chat, and settings

Feature/design contributed by Omkar Satpute in PR #833. This document records
the product contract; tests and implementation define API details.

## What users get

- A centered settings dialog: Overview, Identity, Soul, Skills, Memory, Routines,
  Access, Model, Permissions, Voice & alerts, History, and Usage.
- Standing instructions (SOUL.md) up to 24,000 UTF-8 bytes, separate from the
  existing description/blurb. No automatic migration of existing instructions.
- Setup by conversation: a blank bot interviews the user and proposes its
  profile, working folder, skills, credentials, and routines. /setup starts again.
- Profile confirmation cards, change history, and guarded undo for instructions.
- GitHub skill import, including up to 30 skills, with total request/size/time
  limits. Oversized imports should use specific subfolders.
- A read-only Overview on iOS and Android using the same endpoint as desktop.

## One source of truth

Canonical instructions live in BotRecord.soul in bots.json.
~/.openmausbot/bots/<id>/SOUL.md is a readable mirror, not another database.
The prompt always uses the canonical record. Existing memory, skills, and
workspace storage stay where they are.

External file edits are reported as drift. The bot continues using the saved
instructions until the user reviews the file and chooses Apply or Discard.
These actions pin the displayed file and profile revision. A stale screen must
not overwrite a newer change. Missing mirrors can be recreated; existing
drifted mirrors are never overwritten merely by reading settings or upgrading.

Accepted multi-field changes persist together, including the soul hash. A failed
mirror write cannot change the instructions the model receives. Profile requests
carry a durable identity so retrying an interrupted application does not apply
the same change twice.

## Approval and authority

propose_profile accepts name, title, description, soul, cwd, a reason, and an
optional target bot. It stages a card; it is not a profile-write tool.

The route derives the sender and conversation from the active turn capability,
checks again after reading the body, and verifies team scope at proposal and
confirmation. Chiefs may propose for their section, not arbitrary bots. Sender
IDs in the body are assertions, not authority. Approval rejects a profile that
changed after the proposal was displayed.

Cards show before/after fields and a bounded line diff; large instruction
changes show the complete proposed text. Tool-returned display data is redacted
too, not just persisted messages. Undo uses an immutable history-row ID and the
current profile revision, not a timestamp. If the prior text was redacted,
history explains that it cannot be restored exactly and refuses the operation.
History does not create an additional archive of plaintext credentials.

This is an application tool boundary, **not an OS sandbox**. Full host-shell
access can reach user files and other trusted local interfaces. Neither SOUL nor
Overview promises restrictions that the runtime cannot enforce. Provider
approval rules and saved permissions still apply. Secrets belong in secure
credential cards, never ordinary chat.

## Setup stays small

Setup is a prompt block plus existing confirmation flows, not a workflow engine.
It activates when both description and soul are blank, or for /setup, and only
names tools the selected engine supports.

The bot asks a few useful questions, explains its intended configuration, then
proposes changes. Scheduled work is proposed paused. OAuth, third-party developer
apps, and enabling a routine remain explicit user actions.

Configured bots retain their behavior. The migration button moves a long
description into soul only when chosen. Duplication and backups preserve
standing instructions.

## Honest settings

Overview describes settings, routines, skills, connected apps, and recent profile
changes. Unavailable inventory means “could not be checked,” not “no connection.”
Browser availability respects the workspace flag and engine.

**Prompt preview** uses the same pure assembly helper as turns. It is not the
exact prompt of an active task: task folders, notes, recall, matched skills, and
successfully mounted tools can change dispatch. Token counts are approximate.
Inspecting a preview must not provision a computer or start a model turn.

Settings retain the previous controls. Changing bots resets bot-scoped drafts
and requests; stale responses cannot populate another bot's editor or overwrite
a newer History read. Re-entering Overview refreshes file-backed skill and
memory information.

## Storage and endpoints

- server/system-prompt.ts: pure ordered prompt assembly.
- server/bot-folder.ts: mirror/hash/drift operations.
- server/profile-requests.ts: staged cards and confirmation.
- server/profile-versions.ts: redacted history.ndjson and instruction undo.
- server/bot-overview.ts: shared sentences from collected facts.
- GET /api/bots/:id/overview: desktop and companion summary.
- GET /api/bots/:id/system-prompt: settings preview.
- GET /api/bots/:id/soul: canonical text, drift, and revision.
- POST /api/bots/:id/soul/{apply-file,discard-file}: guarded drift resolution.
- GET /api/bots/:id/history and POST .../history/rollback: history and undo.
- POST /api/internal/profile-requests: capability-bound proposals.

Do not add a generalized transaction framework or shared card resolver just
because several card types exist. Extract mechanics when a concrete repeated
change demonstrates the need. Profile history is not a complete audit log of
every setting, nor a substitute for execution receipts.

## Verification and scope

Follow docs/verification/README.md: use a temporary fake-engine app, never live
user data. Tests cover real /setup dispatch, canonical instructions despite
edited mirrors, authorization and stale approvals, history/undo/recovery,
bounded diffs/imports, and companion routing/decoding.

Renderer interaction needs actual browser/Electron checks as well as unit
tests; phone builds do not prove a physical-device workflow.

Deferred: bundled setup-plan cards, undo beyond soul, per-bot MCP grants, and
live prompt receipts. Each needs its own product and safety decision.
