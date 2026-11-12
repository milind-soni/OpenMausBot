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


## QA notes (Dell, 2026-11-12)

Reviewed commit `1930420`; the three relevant implementation files are unchanged from that commit in the tested checkout. Chrome was driven with Playwright against isolated harness `127.0.0.1:8911` and Vite `127.0.0.1:5211`, with `GBS_DATA_DIR=$TMPDIR/gbs-qa-dell`. Created `TEST · A`, `TEST · B`, and `TEST · Room`. Only test conversations received messages.

| Check | Result | Evidence |
| --- | --- | --- |
| 1. Text restored across bot/room switches | PASS | A multiline draft, B draft, and room draft each restored independently. |
| 2. Text survives full page reload | PASS | All three exact draft values restored after reload and selecting each conversation. Selection itself reset to B; draft text remained correct. |
| 3. Staged attachment restored without reload | PASS | `notes.txt` (18 B) restored in A after visiting B and the room; neither other conversation displayed it. |
| 4. Queued message sends after switching away | FAIL | With a 15-second delayed temporary copy of the repository fake Claude CLI, A was confirmed busy after switching to B. After natural completion A was idle, but its transcript lacked `Dell delayed queued`. Returning to A immediately sent it once. |
| 5. Sending clears draft | PASS | Sending A's text plus attachment emptied the composer and removed its staged attachment. |
| 6. Starter suggestions populate composer | PASS | Cleared newly created B's seeded onboarding transcript via the isolated API to reach the no-message state. Each of `What can you help me with?`, `Plan a small project`, and `Review some code` filled the composer exactly. |
| 7. Drafts do not leak between conversations | PASS | A, B, and room text remained distinct; A's attachment appeared in neither B nor the room. |

Necessary fixes filed on the shared board:

- **High — queued dispatch stops while its composer is unmounted.** Bug task `5a1c7c16-29f5-4bf0-bc12-a9f7f6a31af4`. Reproduce: send to A, queue another message while A is busy, switch to B before completion, wait for A to become idle. The queue waits until A is reopened. `src/components/Composer.tsx:259` owns dispatch in an effect that cannot run while unmounted. Move queue draining to a controller that remains mounted and dispatches exactly once.
- **Normal — failed storage writes lose in-session text.** Bug task `4a6e1bd8-64f0-4c05-b737-a512a081171f`. Additional stress test: save B text `Review some code`; override `Storage.prototype.setItem` to throw `QuotaExceededError` only for `composer-drafts`; replace B text with `Dell storage blocked draft`; switch to the room and back. B restores stale `Review some code`. Restore the original method afterward. `src/lib/composerDrafts.ts:16` excludes text from memory, and `saveDraft` silently catches failed writes. Keep latest text, including cleared text, in memory when storage fails.

Validation: `pnpm exec vitest run src/lib/composerDrafts.test.ts` — 4/4 passed. Browser checks expose integration and storage-failure gaps not covered by those tests. No application code changed. All `[?]` marks remain for user approval. Electron desktop was skipped because dev mode is hard-wired to the live UI port 5199.

Cleanup: isolated browser and harness/Vite processes stopped; `$TMPDIR/gbs-qa-dell` removed. No live process was stopped or restarted, no real bot was messaged, and no direct access to `~/.gbs` was made. Shared-board updates used the harness task API.

## Fixes for Dell's findings (Yv, 2026-11-12)

- [?] **Queued message sends while its conversation is off screen** — `src/lib/useQueuedMessageSender.ts:1`. The queue now lives in `src/lib/composerDrafts.ts`. The app shell drains it whenever the target bot or room is free, so the composer no longer has to be mounted (bug `5a1c7c16`).
- [?] **Latest text survives failed storage writes** — `src/lib/composerDrafts.ts:41`. The latest text, including cleared text, is kept in memory and preferred over storage within a session (bug `4a6e1bd8`). Covered by `src/lib/composerDrafts.test.ts`.
