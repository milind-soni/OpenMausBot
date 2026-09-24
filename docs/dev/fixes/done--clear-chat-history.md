---
status: done
created: 2026-08-13
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: clear chat history
owner: codex
related: []
---

# Clear a direct chat or room history

Let users erase one conversation's persisted transcript without deleting its bot or room. Clearing must be deliberate, unavailable while agents are working, reset any provider continuation state, and synchronize immediately across connected app windows.

---

## 1. Persistence and API

- [x] **Add a durable thread-clear operation** — `server/store.ts:440`. Replace the selected thread with an empty transcript and null active leaf while preserving its bot or room.
- [x] **Expose a guarded clear-history endpoint** — `server/index.ts:820`. Validate thread ownership, reject active or queued conversations, reset direct-chat provider continuation state, remove thread diagnostic logs, and broadcast the completed clear.

## 2. Client synchronization

- [x] **Clear every connected client's conversation state** — `src/state/store.tsx:630`. Handle successful local requests and server-sent clear events by removing messages, active streams, and room activity for only the selected thread.

## 3. Conversation interface

- [x] **Add clear-history actions for direct chats and rooms** — `src/components/Sidebar.tsx:199`. Reuse the existing conversation context menus, visibly disable the action while work is active, and keep the bot or room intact.
- [x] **Require destructive-action confirmation** — `src/components/Sidebar.tsx:600`. Show an accessible, app-styled confirmation dialog that names the conversation and explains that erased history cannot be recovered.

## 4. Verification

- [x] **Cover persistence, authorization, lifecycle guards, synchronization, and UI behavior** — `server/*.test.ts`, `src/**/*.test.ts`. Run the full type-check, test, production-build, Electron syntax, and responsive browser checks.
