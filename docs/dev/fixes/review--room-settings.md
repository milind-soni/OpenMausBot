---
status: review
created: 2026-11-17
updated: 2026-11-17
scope: room settings and member management
owner: claude
related: [review--room-turn-watchdog.md]
---

# Room settings and member management

Let the user rename a room, add and remove bots, and set room-level behaviour (auto handoffs, default responder, handoff depth, inactivity timeout). Plan: `docs/dev/plans/implementation--room-settings.md` (approved 2026-11-17). Does not cover per-room model overrides or bot⇄bot channels.

---

## 1. Server

- [?] **Honour the per-room auto-handoff flag** — `server/index.ts:1006`. Chained handoffs read only the global setting; resolve room value, then global.
- [?] **Add room behaviour fields and migration** — `server/store.ts:76`. `defaultResponderId`, `maxHops`, `turnIdleMs`; `autoHandoffs` becomes inherit-able.
- [?] **Validate the new fields in room PATCH** — `server/index.ts:1628`.
- [?] **Stop and dequeue removed members; post roster-change lines** — `server/index.ts:1628`.
- [?] **Apply default responder, hop depth and per-room idle window** — `server/index.ts` (`startGroupTurn`, `runGroupMemberTurn`).

## 2. UI

- [?] **Room settings sheet (General / Members / Behaviour)** — `src/components/RoomSettings.tsx` (new).
- [?] **Open it from the room header, header more-menu and sidebar room menu** — `src/components/GroupView.tsx:430`, `src/components/Sidebar.tsx:187`.
- [?] **Mirror new fields in client state** — `src/state/store.tsx:228`.

## 3. Verification

- [?] **Server tests for overrides, removal and validation** — `server/room-activity.test.ts`, `server/index.test.ts`, `server/store.test.ts`.
- [?] **Manual QA in an isolated second Electron instance** — desktop and <1180 px widths, `TEST ·` rooms.

## Notes for review

- Room handoffs are now `handoffs: inherit | on | off`. Saved rooms migrate once on load: legacy `autoHandoffs: true` → `on`, everything else → `inherit` (the old `false` was only the creation default and was never honoured). PATCH still accepts the legacy boolean.
- Removing a member stops its active or queued turn, clears it as default responder, and posts "X left the room" / "X joined the room" lines.
- Automated: `server/room-activity.test.ts` (handoff override both ways, depth-2 chain, default responder, busy-member removal, validation), `server/store.test.ts` (migration). Full suite 492/494; the 2 failures in `server/schedules-runtime.test.ts` predate this work.
- Manual QA (isolated Electron instance, `--user-data-dir` + own data dir/ports, `TEST ·` room): opened settings from the header and the sidebar room menu; added Kai; removing a working bot showed the confirm and stopped it; handoffs/depth/default responder/idle saved and persisted; an unmentioned message went to the default responder; layout checked at 1280 and 900 px. Not exercised: the collapsed-header ⋯ menu entry (the header didn't collapse at 900 px).
