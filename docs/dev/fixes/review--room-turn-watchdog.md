---
status: review
created: 2026-11-17
updated: 2026-11-17
scope: room turn timeout
owner: claude
related: [done--stalled-room-activities.md, review--room-settings.md]
---

# Let room turns finish instead of a 5-minute wall clock

Room turns were interrupted after a fixed 5 minutes even while the bot was working, which killed long builds mid-step (`claude exited 143 before result` + `activity timed out and was stopped`). Covers the timeout only; room settings are tracked in `review--room-settings.md`.

---

## Implementation

- [?] **Replace the wall clock with an idle watchdog** — `server/turn-watchdog.ts:1`, `server/index.ts:789`. A turn stops after 20 min with no runtime events (`GBS_GROUP_TURN_IDLE_MS`; legacy `GBS_GROUP_TURN_TIMEOUT_MS` still honoured), with a 3 h ceiling (`GBS_GROUP_TURN_MAX_MS`).
- [?] **Pause the idle clock while an approval is pending** — `server/index.ts` room turn subscriber, `request.opened` / `request.resolved`.
- [?] **Say which limit fired** — "went quiet for 20 min" vs "hit the 3 h limit".

## Verification

- [?] **Unit and end-to-end tests** — `server/turn-watchdog.test.ts`, `server/room-activity.test.ts` (new `slow`/`hang` fake ACP modes). Full suite: 486/488 pass; the 2 failures in `server/schedules-runtime.test.ts` (backup-model retry) fail identically without this change.
- [?] **Manual: a long room build completes** — rerun the Gerer Wavez build that was cut off and confirm it reaches a final reply.
