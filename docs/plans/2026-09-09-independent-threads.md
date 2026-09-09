# One bot, folders, independent threads

The existing direct-bot **Tasks** become **Threads**. They remain the same
durable records and transcript IDs, not a second conversation system.

## Product model

- **Bot:** shared identity, instructions, memory, knowledge, approved skills,
  integrations, and computer preferences.
- **Folder:** optional organization under one bot. Examples: Email, Research,
  Website. It is not a filesystem directory, model setting, security boundary,
  or separate copy of the bot. Existing internal project records and IDs stay
  stable; no project-based model inheritance remains.
- **Thread:** one persistent conversation with its own model/account,
  effort, approval preferences, run state, unread state, and Stop control.
- **Group:** the existing multi-bot channel/room, with its member list and
  separate thread histories retained. Bot-to-bot exchanges remain identifiable.

Folders can be renamed. Threads can be moved or left ungrouped. Removing a
folder ungroups its threads; it does not erase conversations or change models.
Selecting a different thread never redirects work already running. New threads
start from the bot default and then keep their own selection. Existing sections
retain Chief assignments and peer visibility rules; they must never be migrated
into cosmetic folders.

The sidebar shows recent/active threads beneath a bot. **All threads** is the
compact searchable picker, especially useful on smaller screens. The model
picker stays in the chat header, while Ask/Auto stays inside the composer;
both apply to the visible thread. There is no
second "Tasks" area for the same bot conversations.

The sidebar borrows T3's compact searchable conversation hierarchy: quiet
bot/group headings, indented thread rows, restrained active styling, and
working/waiting/unread indicators. No required dashboard or project-creation
step. Threads is the user-facing navigation term on desktop and mobile. Native
clients pin the viewed thread independently of another device's selection;
native folder navigation is a follow-up, not silently claimed as implemented.

## Execution and resource ownership

Each bot defaults to three direct threads at once. Settings → General → Parallel
threads can set the per-bot limit from one to ten. Extra messages wait above
the composer, off the transcript, until that bot has a free slot; they can be
cancelled. The existing queue batches follow-ups within each waiting thread
and drains waiting threads in order. It is in-memory, not restart-durable.
Raising the limit releases queued work; lowering it never stops active turns.
A thread waiting for a human approval occupies a slot. Native provider sessions were already keyed
by thread; the harness now keeps dispatch, permission responses, interruption,
queues, unread state, and background events on that same identity.

Normal thread settings offer Ask and Auto. Full/Custom elevation remains the
existing trusted bot-settings flow; an HTTP task patch cannot grant it.
Webhook/unattended status is thread-scoped, so typing in another thread does
not grant an automated run attended permissions.

New local-agent threads receive independent default working directories.
Existing pinned directories and provider sessions are retained. Overlapping
selected project folders are serialized, including symlink aliases. Managed
browser and host-computer tools acquire a resource on first use and retain
it for the turn. A competing thread receives a clear refusal rather than
interleaving screen actions. Explicit Local VM/VPS work and cloud lifecycle
operations remain conservative. File/folder coordination is **not** a sandbox
against arbitrary commands issued by a Full-access provider.

Shared memory writes use the scoped `memory_update` tool: read current memory,
append or replace/remove one exact entry, then atomically persist it. A stale
or ambiguous replacement fails rather than erasing another thread's notes.
Running prompts retain their initial memory snapshot; later turns see the
new notes. Existing user file access remains supported, not silently revoked.

Generated thread files are retained when conversation metadata is deleted;
deleting a transcript must not silently erase project files. No automatic
file cleanup, account pooling, or external Codex/ChatGPT synchronization is
part of this change.

## Deliberate follow-ups

- Optional inactivity archiving: Never / 24 hours / 1 week / 1 month. Hide
  only idle, finished conversations; preserve history and never archive
  running work or pending human approvals.
- Independent multi-bot group member execution: retain the existing
  serialized room behavior until that orchestration has its own conformance
  tests. Direct threads must not imply parallel control of one physical VM.
- Native mobile organization should use the same records and pinned
  controls, not invent a separate mobile thread model.

## References and verification

T3's provider sessions keyed by thread informed the ownership model. Hermes's
[session turn leases](https://github.com/NousResearch/hermes-agent/blob/b2aa855b626ff8688eb34b95c60ee8b6a4af3679/gateway/turn_lease.py)
and [entry-level memory updates](https://github.com/NousResearch/hermes-agent/blob/b2aa855b626ff8688eb34b95c60ee8b6a4af3679/tools/memory_tool_store.py)
informed generation-checked cleanup and latest-state memory edits. We reuse
OpenMausBot's store, provider adapters, MCP bridge and UI components; no new
orchestration framework or database is needed.

Sidebar reference: [T3 Code at 5e6cc2b895](https://github.com/pingdotgg/t3code/tree/5e6cc2b89534a8e01772bf647b79a1f2da2f9664/apps/web/src/components).
Adapt the interaction patterns to existing OpenMaus components. If copying
source, retain its MIT copyright/license notice instead of changing its license.

See [chat verification](../verification/chat-turns.md),
`server/independent-threads-api.test.ts`, `server/bot-projects-api.test.ts`,
and the store/resource tests for isolated fake-engine proofs. UI interaction
must also be checked on an isolated renderer before release.
