---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: room user cut-in and steering feasibility
owner: Yv
related: [review--room-mentions-always-answered.md]
---

# User messages take priority over room handoffs

A message sent while a room bot is working reaches the server immediately. The running turn finishes, then the user message is answered before further replies from the previous chain. Mid-response steering remains a separate proposed feature.

## Implementation

- [?] **Send room messages immediately while busy** — `src/components/Composer.tsx:59`. Rooms show “your message goes next”; DMs keep the existing local queue.
- [?] **Stop obsolete pending replies after a user cut-in** — `server/index.ts:896`. Track the user-message count across the whole chain, skip pending chained and direct responders, and remove their queue entries. Counts avoid millisecond timestamp ties.
- [?] **Explain skipped handoffs** — `server/index.ts:1055`. The room reports “Your message goes first; NAME wasn't called in.”
- [?] **Document mid-response steering** — `docs/dev/plans/implementation--mid-turn-steering.md`. Native Claude/Codex input and interrupt/restart fallback are proposed, not implemented.

## Verification

- Typecheck passes. Full suite: 501/503; the same two pre-existing backup-retry failures in `server/schedules-runtime.test.ts`.
- Focused room tests cover both a pending handoff and an already queued direct responder; all 11 focused tests pass.
- Isolated server uses `/tmp/gbsqa4`, port 8977, fake ACP providers only. Visible Studio Preview on port 5297: sent “@TEST · Alpha and @TEST · Beta begin QA”, then “@TEST · Gamma course correction QA” while Alpha's eight-second turn was open. Saved transcript shows the correction before Alpha's reply, the skipped-Beta note, then Gamma's reply; Beta never speaks. Room transcript and idle activity states inspected after reload. Screenshot capture timed out, so no new screenshot evidence is claimed.
- Existing isolated Electron process from the earlier session was used only as fixture infrastructure and is stopped during cleanup. The user's real data and real app were not changed.
- Trello sync attempted; failed with “Workspaces are full”. Local board remains authoritative.
- User review after restarting Studio remains pending; implementer does not self-approve.
