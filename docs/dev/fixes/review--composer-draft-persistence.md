---
status: review
created: 2026-11-12
updated: 2026-11-12
scope: composer draft persistence
owner: Yv
related: [doing--first-run-ux-friction.md]
---

# Keep typed messages when switching between bots and rooms

Text typed in a bot's or room's message box disappeared when the user switched to another conversation and came back. Staged attachments and a message queued during a busy turn were also lost. Covers draft persistence only.

---

## 1. Fix

- [?] **Store drafts per conversation** — `src/lib/composerDrafts.ts:1`. Text is kept per bot or room in localStorage, so it also survives a restart. Attachments and the queued message are kept in memory. Sending clears the draft. Tests: `src/lib/composerDrafts.test.ts`.
- [?] **Restore and save drafts in the composer** — `src/components/Composer.tsx:62`. The composer restores its draft on mount and saves on every change. A message queued before switching away is sent once the bot is free.
- [?] **Verify in the app** — Dell: type in bot A, switch to bot B and to a room, then return. Restart the app and confirm the text is still there. Stage an attachment, switch, and return. Queue a message while A is busy, switch away, and confirm it still sends.
