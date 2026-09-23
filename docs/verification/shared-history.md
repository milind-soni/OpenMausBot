# Shared conversation history

Run:

```sh
pnpm exec vitest run server/shared-history.test.ts server/shared-history.e2e.test.ts server/recent-work.test.ts server/recent-work.e2e.test.ts server/recall-disclosure.test.ts server/delta-context.e2e.test.ts server/routine-results.e2e.test.ts server/thread-capacity-api.test.ts server/independent-threads-api.test.ts
```

The unit cases cover a user handoff before any bot reply; corrections and named
speakers; private and teammate sources; group membership, removed groups/tasks,
active branches, queued messages, non-text cards, complete-message length limits,
delimiter escaping and deterministic ordering.

The isolated server fixture creates two bots and a room, dispatches through the
repository's scripted engine, and inspects the actual consumed request. A private
requirement reaches the room, the user's room handoff reaches a later private
request, the unrelated bot's private conversation does not, and deleting the room
removes it from newly constructed history. It also checks the private-source
activity notice. This proves context assembly and routing, not model accuracy.

Shared history replaces the short recent-work excerpt at private and room
dispatch. It is a chronological record of complete text messages, bounded to
64,000 characters including wrapper and notice. Newer complete records are kept
when the limit is reached; oversized records are omitted, never silently cut.
The current conversation is excluded because the ordinary session/transcript
path already supplies it. Existing room audience filtering remains in force.

The reader uses the Store's active paths and cached transcripts. On a cold start,
accessing another conversation can hydrate its stored transcript; this change
is not a database-loading optimization. The 64,000-character cap bounds the
additional prompt, not total disk history. Large histories can increase input
cost relative to the former 1,400-character brief. Deleted sources are excluded
from subsequent snapshots; this does not erase requests already sent to a
provider or information already present in its native session.

Delegated tasks keep their explicit task scope. Automatic private-chat continuation wakes retain the existing handoff ledger
instead of taking another cross-chat snapshot. This prevents duplicate or
premature delivery of delegated replies. The unchanged delta-context suite
checks queued replies, session resumption, replay and profile/model changes.

Fresh unattended routine executions retain their explicit input and do not import
previous runs through shared history. A human opening a completed run as a chat
can still use ordinary cross-conversation context. Independent task tests retain
separate user-message records, message IDs, processes, models and permissions;
the same bot may see the other task as labeled historical context.
