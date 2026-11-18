---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: composer send feedback
owner: claude
related: [review--room-settings.md]
---

# Tell the user when a message is too large to send

Sending a prompt over the server's 1 MB body limit (attachments count, as base64) made it vanish: the composer cleared the draft before the server answered, the server replied `413 body too large`, and rooms had no error banner to show it.

---

## Implementation

- [?] **Check size before sending, keep the draft** — `src/lib/messageSize.ts`, `src/components/Composer.tsx`. An oversized message is not sent or queued; the text and attachments stay, and an alert above the composer gives the size, the limit, and what to do.
- [?] **Rooms show send errors** — `src/components/GroupView.tsx` now renders the shared error banner, like `ChatView`.
- [?] **Plain wording for a server 413** — `src/state/store.tsx` `api()` rewrites `body too large` into a sentence that says nothing was sent.

## Verification

- [?] **Unit tests** — `src/lib/messageSize.test.ts`. Full suite: 496/498 pass; the 2 failures in `server/schedules-runtime.test.ts` (backup-model retry) predate this change.
- [?] **Desktop QA (isolated instance)** — in a `TEST ·` room, a 1.8 MB text prompt and an ~880 KB image attachment were both refused with the alert, and the draft stayed in the composer.

## Not covered

- [ ] **Editing a past message** still clears the editor before sending; an oversized edit shows the new 413 wording in the chat banner but the edited text is lost.
- [ ] **The 1 MB limit itself** — a single screenshot over ~750 KB hits it. Raising it means storing larger base64 data in message history; decide separately.
