---
status: review
created: 2026-11-18
updated: 2026-11-18
scope: room handoffs
owner: claude
related: [review--room-settings.md]
---

# A bot mentioned in a room always answers

In Gerer Wavez, bots kept @mentioning each other with no reply: e.g. 18 Nov 00:05, Yv's "@SoSo, commit slice 1 now" went unanswered until the user wrote again. A chain skipped any bot that had already spoken for the current user message, so a handback (A → B → A) always died after one round trip, regardless of the room's handoff depth.

---

## Implementation

- [?] **Chained mentions always run** — `server/index.ts` `runGroupMemberTurn`. The `spoken` set now only stops a direct responder from running twice ("@Scout ask @Pixel"); it no longer blocks handbacks.
- [?] **Depth becomes a runaway cap** — "Handoffs in a row" 5 / 10 / 25, default 10 (`ROOM_DEFAULT_HOPS`, max `ROOM_MAX_HOPS` = 25 in `server/store.ts`). Stored 1–3 depths from the old setting are dropped on load so those rooms get the default.
- [?] **No silent drops** — when the cap is reached, or auto handoffs are off, the room shows "Paused after N handoffs. Mention X to continue." / "Auto handoffs are off. Mention X to continue."
- [?] **Wider mention matching** — `mentionedBots` accepts a tag after any character except a letter, digit, `.`, `@`, `/` or `\`, so `"@SoSo"`, `“@SoSo”` and `thanks,@SoSo` count; emails and URLs still don't.
- [?] **Room settings copy** — `src/components/RoomSettings.tsx`.

## Verification

- [?] **Tests** — `server/room-activity.test.ts` (back-and-forth until the cap with the pause note; off-room note; new validation range), `server/comms.test.ts` (punctuation), `server/store.test.ts` (legacy depth dropped). Full suite 500/502; the 2 `server/schedules-runtime.test.ts` backup-retry failures predate this.
- [?] **Desktop QA (isolated instance)** — two fake bots mentioning each other in a `TEST ·` room ran Alpha → Beta → Alpha → Beta → Alpha → Beta, then showed the pause note; Room settings shows "Handoffs in a row 5 / 10 / 25".
- [ ] **Manual: Gerer Wavez** — after restart, check Yv and SoSo hand work back and forth without a nudge.
