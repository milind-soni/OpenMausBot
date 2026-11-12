---
status: review
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

- [?] **Engine usage-data spike** — SoSo. Capture what Claude Code, Codex, Grok, and Antigravity report about remaining usage and limit errors. Save the fixtures to `server/testing/fixtures/usage/` and fill in the table in the plan.
- [?] **Ring design** — Z. Cover:
  - size, placement, color thresholds, the unknown state
  - tooltip and popover content
  - collapse under 900px
  - accessibility

  Deliver specs in `docs/design/usage-rings.md`.

## 2. Foundation

- [?] **Usage store** — `server/usage.ts`. Holds normalized per-engine windows, persisted atomically.
- [?] **Driver classifiers and usage events** — `server/drivers/claude.ts:369`, `server/drivers/codex.ts:298`, plus the Grok and Antigravity drivers. Adds the new `usage_limit` error kind with `resetsAt`.
- [?] **API and SSE** — `GET /api/usage` and a `usage` frame.

## 3. Rings

- [?] **UsageRings component, tooltip, and popover** — Placed in the top bar.
- [?] **Settings toggles** — Show or hide the rings, plus per-engine hide.

## 4. Docs and QA

- [?] **User guide** — `docs/guide/usage-and-limits.md`.
- [ ] **QA** — Dell. Check real engines and simulated exhausted states with the fake CLIs.

## Spike handoff — 2026-11-12

The engine research is ready for review. Findings and evidence provenance are in the plan and fixture inventory. One Codex account read was made without starting a model turn. Unobserved limit errors are clearly labeled as constructed examples or binary evidence. Foundation, ring design, app behavior, and QA items above remain open.

Trello mirroring is pending because this worktree has no Trello credentials.

## Foundation and rings handoff — 2026-11-12

Implemented sections 2–4; Dell’s QA remains open. Z’s design and Marty’s glossary/copy were read directly from the main checkout without copying or changing those files.

- `server/usage.ts` persists normalized windows atomically, retains sparse/null values, ignores older updates, and masks readings after 15 minutes or a passed refresh time. Individual window freshness is retained through unrelated updates.
- Codex reads on turn app-server initialization and through a separate bounded read-only connection while idle. Idle reads share a five-minute gate across open SSE clients; no open clients means no idle reads. Unsupported reads leave usage unknown and do not block conversations.
- Account updates are handled before chat lookup. `GET /api/usage` and initial/live `usage` SSE frames use the existing request guard. Display settings persist without reloading providers or interrupting conversations.
- `UsageLimitFailure` is a clean export from `server/usage-types.ts` (also re-exported by `server/usage.ts`). `runtime.error` and failed `turn.completed` events carry `failure.kind = "usage_limit"`; the harness attaches a future reset only when every exhausted window has one. See the implementation notes in the plan for consumers.
- Rings appear in chat, rooms, Apps, Projects, Tasks, and Settings headers. They include hover/focus tooltips, keyboard dialogs, window details, affected bots, a below-900px summary, non-color badges and text, and persisted master/per-app display switches. Windows caption controls retain clearance.
- The plain-language guide is bundled into the popover, so it opens in packaged apps as well as development builds.

### Contract-based design deviations

- Claude reports passive exhaustion/status only. Its percentage scale and reset units were not verified in the spike; constructed examples are not used to guess those units. Claude’s amount and refresh time remain unknown.
- Grok and Antigravity remain unknown. Their fixtures contain binary evidence, not validated error envelopes; generic throttling/resource errors are not classified as an empty account.
- Unknown-state copy does not promise automatic switching. The backup action opens bot settings as authorized; there is no backup field to focus until the next feature lands.
- The ring uses plain allowance wording rather than technical window terminology. The guide opens inline rather than linking to a source file that would be absent in packaged builds.

### Validation

- `pnpm typecheck`: passed.
- `pnpm test`: 42 files, 327 tests passed. Covers fixture classifiers, sparse merge/persistence, staleness, cadence/overlap gates, fake-CLI usage reads and failures, guarded API/SSE, display settings, ring geometry and accessible labels.
- `pnpm build`: passed; existing large-chunk advisory remains.
- No real inference calls were made for usage checks. Tests use isolated homes and scripted CLIs.
- Trello mirroring remains pending: worktree credentials are absent.
