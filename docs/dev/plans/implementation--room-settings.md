# Implementation plan: room settings and member management

## Objective

Give the user one place to manage a room: rename it, add and remove bots, and set room-level parameters that change how bots behave in that room. Out of scope: per-room model overrides, room permissions/roles, bot⇄bot `dm` channels (their settings stay hidden), and room templates.

## Current state

- `PATCH /api/groups/:id` already accepts `name`, `bulletin`, `memberIds`, `autoHandoffs` and `projectId` (`server/index.ts:1628`), and the client already has a `patchGroup` action (`src/state/store.tsx:228`). The UI does not expose most of it.
- `GroupView` exposes only the bulletin (pinned strip, `src/components/GroupView.tsx:508`) and the project picker inside the Tasks panel. There is no rename, no add/remove member, no settings surface. The sidebar room menu has copy-ID, clear and delete only (`src/components/Sidebar.tsx:187`).
- **Bug:** the per-room `autoHandoffs` flag is stored (`server/store.ts:83`) but chained handoffs read only the global `cfg.autoHandoffs` (`server/index.ts:1006`), so the room value has no effect.
- Removing a member through the API today does not touch a turn that member is running or queued for.
- Room turn length is governed by the new watchdog (`server/turn-watchdog.ts`, 20 min idle / 3 h ceiling, process-wide env only).
- Unmentioned messages get no reply unless the room has one member (`server/index.ts`, `startGroupTurn`).

## Proposed changes

1. **Room settings sheet** — new `src/components/RoomSettings.tsx`, opened from a gear button in the room header (and the header "more" menu when collapsed) and from a new "Room settings…" item in the sidebar room menu. Sections:
   - **General:** room name; bulletin (same field as the pinned strip, both stay in sync); linked project.
   - **Members:** list of members with avatar, name, role and a Remove button; an "Add bots" picker listing the bots not in the room. The last member cannot be removed (the server already rejects an empty room). A member that is working or queued shows a badge; removing it asks for confirmation and stops its activity.
   - **Behaviour:**
     - *Auto handoffs:* Use app default / On / Off.
     - *Default responder:* which bot answers a message with no @mention (None, the current behaviour, or a chosen member).
     - *Handoff depth:* how many bot-to-bot hops a chain may take (1–3, default 1).
     - *Inactivity timeout:* 10 / 20 / 45 / 90 min (default: app default, 20 min). The 3-hour ceiling stays global.
2. **Data model** — `server/store.ts` `GroupRecord` gains optional `autoHandoffs: boolean | null` semantics (null = inherit), `defaultResponderId?: string | null`, `maxHops?: number`, `turnIdleMs?: number | null`. Loading normalises missing fields to inherit; existing `autoHandoffs: false` rooms are migrated to `null` (inherit), because the old value was never honoured and was written by default at creation. Client `Group` type mirrors it.
3. **Server** — extend the PATCH validator for the new fields (type and range checks, `defaultResponderId` must be a member). Room behaviour reads room value → global fallback for handoffs, hop limit and idle window. When `memberIds` drops a bot: stop its active turn (the same path as `/activities/:botId/stop`), remove it from `queuedBotIds`, and clear `defaultResponderId` if it pointed at that bot. Post a system activity line in the room ("Ada was added", "Rio was removed") so other bots see the roster change in context.
4. **No new endpoints**; everything goes through the existing PATCH, which keeps the WebSocket broadcast path unchanged.

## Verification

- `server/store.test.ts`: normalisation and migration of old room records.
- `server/room-activity.test.ts` (fake ACP CLIs): per-room auto-handoff override beats the global setting in both directions; default responder answers an unmentioned message; hop depth 2 chains twice; removing a busy member stops its turn and removes it from the queue; a per-room idle window expires a quiet turn.
- `server/index.test.ts`: PATCH validation rejects bad types, out-of-range hops, non-member responder.
- `src/lib/*.test.ts`: reducer handles the new fields.
- `pnpm typecheck`, `pnpm test`.
- Manual (isolated second Electron instance, `TEST ·` rooms): rename, add, remove (idle and busy), each behaviour toggle, at desktop width and at the narrow (<1180 px) header-collapse width.

## Risks and rollback

- Migrating `autoHandoffs: false` → inherit changes behaviour only for users whose global setting is off — those rooms keep handoffs off. Users with global on will now see handoffs in rooms that were silently ignoring the flag anyway, so behaviour matches what they already saw.
- Stopping a removed member's turn mid-edit could lose uncommitted bot work; the confirm dialog says so.
- Everything is additive on the record; rolling back the commit leaves extra unused fields on disk, which older builds ignore.

## Approval

Status: approved by user, 2026-11-17
