---
status: done
created: 2026-08-13
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: room activity panel
owner: codex
related: []
---

# Add a live room activity panel

Give room users a dedicated right-side workstream that shows what every agent is currently doing, which agents are queued, what tools/processes are running, where approval is needed, and the latest completed or failed activities.

---

## 1. Runtime activity contract

- [x] **Attribute room runtime events to the active agent** — `server/index.ts:130`, `src/state/store.tsx:880`. Include a trusted agent identity on room runtime frames so concurrent UI state never infers ownership from message text.
- [x] **Expose queued room responders** — `server/store.ts:65`, `server/index.ts:590`. Track the ordered transient queue alongside the active room member and clear it correctly on completion, interruption, error, and restart.

## 2. Client activity model

- [x] **Fold canonical runtime events into per-agent activity state** — `src/state/roomActivity.tsx:1`. Track running turns, active tools, approval waits, failures, completion time, and bounded recent history without forcing transcript-wide rerenders for every event.
- [x] **Reconstruct useful recent history after reload** — `src/components/RoomActivityPanel.tsx:1`. Combine ephemeral live state with attributed persisted activity messages while deduplicating tool entries.

## 3. Room interface

- [x] **Add the desktop right-side activity panel** — `src/components/GroupView.tsx:1`, `src/components/RoomActivityPanel.tsx:1`. Show one status card per member, current activity, elapsed time, queue position, and recent outcomes using the existing visual system.
- [x] **Add responsive panel controls** — `src/components/GroupView.tsx:1`. Keep the panel visible on wide screens, make it a toggled drawer on compact layouts, preserve chat width and scrolling, and include accessible labels and keyboard behavior.

## 4. Verification

- [x] **Cover lifecycle, attribution, queues, and responsive interaction** — `server/*.test.ts`, `src/lib/*.test.ts`. Run full type-checks, tests, production build, syntax checks, and visual checks at compact and wide desktop sizes.
