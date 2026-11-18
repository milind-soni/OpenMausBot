---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: composer send feedback
owner: claude
related: [review--room-settings.md]
---

# Tell the user when a message is too large to send

Sending a prompt over the server's body limit (then 1 MB) (attachments count, as base64) made it vanish: the composer cleared the draft before the server answered, the server replied `413 body too large`, and rooms had no error banner to show it.

---

## Implementation

- [?] **Check size before sending, keep the draft** — `src/lib/messageSize.ts`, `src/components/Composer.tsx`. An oversized message is not sent or queued; the text and attachments stay, and an alert above the composer gives the size, the limit, and what to do.
- [?] **Rooms show send errors** — `src/components/GroupView.tsx` now renders the shared error banner, like `ChatView`.
- [?] **Plain wording for a server 413** — `src/state/store.tsx` `api()` rewrites `body too large` into a sentence that says nothing was sent.

## Verification

- [?] **Unit tests** — `src/lib/messageSize.test.ts`. Full suite: 496/498 pass; the 2 failures in `server/schedules-runtime.test.ts` (backup-model retry) predate this change.
- [?] **Desktop QA (isolated instance)** — in a `TEST ·` room, a 1.8 MB text prompt and an ~880 KB image attachment were both refused with the alert, and the draft stayed in the composer.

## Follow-up (approved 2026-11-18)

- [?] **Keep the text when an edit is too large** — `src/components/ChatView.tsx` `BubbleEditor` checks size before closing the editor and shows the alert in the bubble.
- [?] **Raise the message limit to 25 MB** — `server/index.ts` `MAX_MESSAGE_BODY_CHARS` on the room, bot, and edit message routes; `src/lib/messageSize.ts` matches it.
- [?] **History links attachments instead of storing base64** — once saved to the workspace, attachments keep `path` + `url` and drop `dataUrl`, so thread files stay small. New `GET /api/attachments/:thread/:file` serves them with `Content-Security-Policy: sandbox` and `nosniff`; unknown types download as bytes. `AttachmentViewer` falls back to `url`. Older messages keep their inline data and still render.
- [?] **Attachment ids are sanitized before use in file names** — a client id like `../../x` could previously steer the write outside the attachments folder.
- [?] **A rejected oversized upload gets the 413, not a connection reset** — `readBody` keeps draining after the limit instead of pausing.
- [?] **Tests** — `server/index.test.ts` covers the served link, path traversal, a 4 MB attachment, a 26 MB refusal, and id sanitizing. Full suite 497/499 (same 2 pre-existing failures).
- [?] **Desktop QA (isolated instance)** — a 4.8 MB PNG sent in a `TEST ·` room displayed from `/api/attachments/…`, the thread file stayed under 1 KB, and the bot read the saved file. A 26 MB edit in a DM was refused with the editor and text kept, and nothing reached the server.
