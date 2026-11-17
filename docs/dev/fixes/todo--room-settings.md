---
status: todo
created: 2026-11-17
updated: 2026-11-17
scope: room settings and member management
owner: unassigned
related: [review--room-turn-watchdog.md]
---

# Room settings and member management

Let the user rename a room, add and remove bots, and set room-level behaviour (auto handoffs, default responder, handoff depth, inactivity timeout). Plan: `docs/dev/plans/implementation--room-settings.md` (awaiting approval). Does not cover per-room model overrides or bot⇄bot channels.

---

## 1. Server

- [ ] **Honour the per-room auto-handoff flag** — `server/index.ts:1006`. Chained handoffs read only the global setting; resolve room value, then global.
- [ ] **Add room behaviour fields and migration** — `server/store.ts:76`. `defaultResponderId`, `maxHops`, `turnIdleMs`; `autoHandoffs` becomes inherit-able.
- [ ] **Validate the new fields in room PATCH** — `server/index.ts:1628`.
- [ ] **Stop and dequeue removed members; post roster-change lines** — `server/index.ts:1628`.
- [ ] **Apply default responder, hop depth and per-room idle window** — `server/index.ts` (`startGroupTurn`, `runGroupMemberTurn`).

## 2. UI

- [ ] **Room settings sheet (General / Members / Behaviour)** — `src/components/RoomSettings.tsx` (new).
- [ ] **Open it from the room header, header more-menu and sidebar room menu** — `src/components/GroupView.tsx:430`, `src/components/Sidebar.tsx:187`.
- [ ] **Mirror new fields in client state** — `src/state/store.tsx:228`.

## 3. Verification

- [ ] **Server tests for overrides, removal and validation** — `server/room-activity.test.ts`, `server/index.test.ts`, `server/store.test.ts`.
- [ ] **Manual QA in an isolated second Electron instance** — desktop and <1180 px widths, `TEST ·` rooms.
