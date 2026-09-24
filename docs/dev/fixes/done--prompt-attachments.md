---
status: done
created: 2026-08-14
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: prompt attachments
owner: assistant
related: []
---

# Attach images and files to prompts

Allow users to attach images and files (documents, code, text, etc.) to messages in 1:1 bot chats and group rooms via file picker, drag-and-drop, and clipboard paste. Staged attachments display interactive preview chips in the composer, persist in the message transcript, render cleanly in the conversation history, and are delivered to bot drivers with disk persistence and contextual metadata so models can inspect and process attached files.

---

## 1. Data model & server persistence

- [x] **Define attachment data contracts** — `server/contracts.ts:89`, `server/store.ts:41`, `src/state/store.tsx:31`. Define `Attachment` data structures with unique IDs, name, MIME type, byte size, data URL, and optional text preview content.
- [x] **Store attachments in message transcripts** — `server/store.ts:180`, `server/store.ts:320`. Update `appendMessage` and `branchMessage` to store and persist attachment records across restarts and branches.
- [x] **Save attachments to thread workspaces on turn dispatch** — `server/index.ts:330`, `server/index.ts:1076`. Write incoming attachments to per-thread attachment storage under `DATA_DIR` so CLI tools and agents have local file access, and pass attached file context to `SendTurnInput`.

## 2. API & turn routing

- [x] **Support attachments in chat routes** — `server/index.ts:1076`, `server/index.ts:1197`, `server/index.ts:1210`. Accept attachments on `POST /api/bots/:id/messages`, `POST /api/groups/:id/messages`, and `POST /api/bots/:id/messages/:msgId/edit`, allowing messages with attachments even if text is empty.
- [x] **Augment driver turn prompts with attachment metadata** — `server/index.ts:350`, `server/drivers/claude.ts:452`, `server/drivers/antigravity.ts:140`, `server/drivers/codex.ts:363`. Include structured attachment references (file paths, types, sizes, and text snippets) in the turn prompt so every driver can access and understand attached media.

## 3. Composer interaction & staged attachments

- [x] **Add file picker and attachment controls** — `src/components/Composer.tsx:180`. Add an attachment button (paperclip icon) triggering a hidden file input supporting images and all file types.
- [x] **Support drag-and-drop and clipboard paste** — `src/components/Composer.tsx:180`. Add dropzone highlight on dragging files over composer and handle pasted images/files from the clipboard.
- [x] **Display staged attachment preview tray** — `src/components/Composer.tsx:200`. Render removable preview chips with image thumbnails or file type icons, filenames, and formatted sizes.

## 4. Chat history rendering & sidebar previews

- [x] **Render attachments in direct chat bubbles** — `src/components/ChatView.tsx:230`. Display image grids/thumbnails with preview enlargement and download/open cards for attached files.
- [x] **Render attachments in room chat bubbles** — `src/components/GroupView.tsx:60`. Render attachments in room messages with proper sender attribution.
- [x] **Update message previews in sidebar** — `src/components/Sidebar.tsx:140`. Show `[Image]` or attachment summaries in conversation previews when text is omitted or accompanied by attachments.

## 5. Automated tests & verification

- [x] **Add server tests for message attachments** — `server/store.test.ts`, `server/index.test.ts`. Test message creation, persistence, branching, and API endpoints with attachments.
- [x] **Verify type-check and test suite** — `server/`, `src/`. Ensure all tests pass and typechecks succeed.

