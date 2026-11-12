---
status: todo
created: 2026-11-12
updated: 2026-11-12
scope: usage rings and usage-limit foundation
owner: SoSo
related: [todo--scheduled-runs-and-backup-model.md]
---

# Remaining-usage rings in the top bar (and the usage-limit foundation)

Implements `docs/dev/plans/implementation--usage-rings.md`. The spike and the design start now. Code starts after plan approval.

---

## 1. Spike and design

- [ ] **Engine usage-data spike** — SoSo. Capture what Claude Code, Codex, Grok, and Antigravity report about remaining usage and limit errors. Save the fixtures to `server/testing/fixtures/usage/` and fill in the table in the plan.
- [ ] **Ring design** — Z. Cover:
  - size, placement, color thresholds, the unknown state
  - tooltip and popover content
  - collapse under 900px
  - accessibility

  Deliver specs in `docs/design/usage-rings.md`.

## 2. Foundation

- [ ] **Usage store** — `server/usage.ts`. Holds normalized per-engine windows, persisted atomically.
- [ ] **Driver classifiers and usage events** — `server/drivers/claude.ts:369`, `server/drivers/codex.ts:298`, plus the Grok and Antigravity drivers. Adds the new `usage_limit` error kind with `resetsAt`.
- [ ] **API and SSE** — `GET /api/usage` and a `usage` frame.

## 3. Rings

- [ ] **UsageRings component, tooltip, and popover** — Placed in the top bar.
- [ ] **Settings toggles** — Show or hide the rings, plus per-engine hide.

## 4. Docs and QA

- [ ] **User guide** — `docs/guide/usage-and-limits.md`.
- [ ] **QA** — Dell. Check real engines and simulated exhausted states with the fake CLIs.
