---
status: doing
created: 2026-11-12
updated: 2026-11-19
scope: scheduled runs, auto-resume, backup model
owner: SoSo
related: [todo--usage-rings.md]
---

# Scheduled runs, auto-resume when usage runs out, and backup model

Implements `docs/dev/plans/implementation--scheduled-runs-and-backup-model.md`. Design and copy start now. Code starts after plan approval. Parts 2 and 3 depend on the usage-limit foundation in `todo--usage-rings.md`.

---

## 1. Design and copy

- [ ] **Design** — Z. Cover:
  - the Schedules screen
  - the "New schedule" sheet
  - "Send later…" in the composer
  - the scheduled-message label
  - the auto-resume notice with Cancel / Resume now
  - the backup-model settings and the "using backup" badge

  Deliver specs in `docs/design/schedules.md`.
- [ ] **Copy** — Marty. Write all labels, empty states, notices, and the two user guides in plain language.

## 2. Scheduled runs

- [?] **Schedule store and next-run maths** — `server/schedules.ts`. Covers all repeat kinds, timezone, DST, and the missed-run grace window.
- [?] **Scheduler loop** — `server/index.ts`. Uses a single timer. Sends due prompts as labeled user messages and queues them when the bot is busy.
- [?] **API and SSE** — `/api/schedules` CRUD, run-now, and a `schedules` frame.
- [?] **Bot tools** — `server/drivers/agents-proxy.ts`. Adds `create_schedule`, `list_schedules`, and `cancel_schedule`, scoped to the bot's own threads and rooms and capped at 20 per bot.
- [?] **Schedules screen, chat header button, and "Send later…"** — Covers `src/components/Composer.tsx` and a new `SchedulesScreen.tsx`.
- [?] **Keep running in the menu bar or tray (opt-in)** — `electron/main.mjs`, so schedules fire while the window is closed.

## 3. Auto-resume and backup model

- [?] **Bot fields and migration** — `server/store.ts:106`, `src/state/store.tsx`. Adds `backupModelSelection` and `onUsageLimit`.
- [?] **Usage-limit handling** — Switch to the backup and retry, or create one auto-resume schedule per thread at the reset time (with backoff when the time is unknown), or stop and notify.
- [?] **Switch back after refresh** — Only on the next new turn. Adds the "using backup" badge with a pin option.
- [?] **Persistent two-way failover** — Across chat and room turns, the other configured model can retry a limited request once. Both selections and the active backup flag persist. Making the backup the main model swaps the two selections. — `server/index.ts`, `src/components/ModelPicker.tsx`.
- [?] **Bot settings UI** — Adds "Backup model" and "When usage runs out".

## 4. Docs and QA

- [?] **User guides** — `docs/guide/schedules.md`, `docs/guide/backup-model.md`.
- [ ] **QA** — Dell. Run the plan's verification list, including sleep and quit scenarios and a room schedule.

## Notes for review (SoSo, 2026-11-12)

Where the spec or copy conflicted with safe behavior, the safe choice was built:

- **Retry delay when no refresh time is known.** Claude's `rate_limit` error can be a short throttle, so wait-and-continue starts at 15 minutes and backs off (30, 60, … capped at 6 hours). One pending auto-resume per conversation is updated, never stacked.
- **Backup retries.** The model never changes mid-turn. The failed turn is retried on the backup after it ends, without adding a second copy of the user's message. The saved main model is not changed.
- **Switching back.** Only on the next new turn, once the usage store reports the main engine as not exhausted. Claude, Grok and Antigravity usage is "unknown", so for those the user switches back by hand.
- **"Keep using backup" pin.** Built as **Keep this model**, which makes the backup the main model, instead of a separate pin flag that would need its own lifetime rules. **Switch back now** is included as specified.
- **Uncertain crash during dispatch.** If the app stops while a scheduled message is being sent, the run is marked for review rather than replayed, so a message is never sent twice.
- **Missed runs.** A run is caught up once inside the grace window; older misses are recorded as missed. After several days offline, a repeating schedule runs at most its latest eligible occurrence. A run accepted while the bot was busy stays queued even past the grace window.
- **Existing bots** keep "Stop and tell me" on upgrade (plan's migration rule); new bots default to "Wait and continue".
