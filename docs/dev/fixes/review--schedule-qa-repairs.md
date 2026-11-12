---
status: review
created: 2026-11-12
updated: 2026-11-12
scope: schedules QA repairs
owner: SoSo
related:
  - doing--scheduled-runs-and-backup-model.md
---

# Schedule validation and recovery UI repairs

Implement the three assigned bugs from Dell's QA report at `0a1f34a`, in `feat/scheduled-runs` only. Use disposable server/browser data and no real AI turns.

- [?] `efe15245-d22a-4658-9afb-db65dc6d3e17`: reject malformed dual targets on public/internal creation and updates — `server/schedules.ts:9`.
- [?] `ca15c855-4813-4b7f-b0e5-be0b461d96cd`: retain sheet focus, Tab trapping and Escape dismissal after save failures; preserve drafts — `src/components/ScheduleSheet.tsx:30`.
- [?] `cb983db0-e045-4c4a-8729-1d387d3de3c7`: isolate retry feedback and late action completions by conversation — `src/components/AutoResumeNoticeCard.tsx:3`.

Task statuses updated to doing through the guarded task API. No task connector or internal-task credentials are exposed in this session; the public revision-checked task routes provide the supported update operation. No direct task-file edits.

## Implementation and verification

- `c8bc7cd` — targets must be an object containing exactly one supported key and a nonempty string ID. Extra target keys are refused even when null, numeric, boolean, empty or undefined (the latter is covered at the store boundary). Validation runs before persistence for create/update. Regressions cover both bot/room directions, public POST/PATCH, internal POST, unchanged state after rejection, and persistence after a rejected update.
- `a0743a3` — the pending state explicitly focuses the dialog instead of leaving focus on its disabled submit control. Failure focuses the accessible error notice. A cleaned-up window key listener supports Escape and Tab recovery even if focus falls outside; disabled controls and hidden catch-up fields are excluded from Tab wrapping. Failed saves preserve the draft, and dismissal returns focus to the trigger. Pending saves remain non-dismissible.
- `1a655c6` — feedback and pending callbacks live in a child keyed by conversation ID. A response from a previous chat cannot write status, error or pending state into another chat or a remounted room. Starting an action clears earlier feedback for that conversation. Includes the repeatable browser regression runner `scripts/testing/schedules-ui-regression.mjs`.

Checks on the final source:

- `pnpm -s typecheck`: pass.
- `pnpm -s test`: **381 tests in 45 files pass**, including 46 focused schedule/store/runtime tests (20 more cases than the reviewed baseline).
- `pnpm -s build`: pass; existing large-chunk advisory remains.
- `node --check scripts/testing/schedules-ui-regression.mjs` and `git diff --check`: pass.
- **8 browser regressions pass in headless Chrome and again in headed Chrome**: failed-save focus; Tab/Shift+Tab wrapping; Escape, trigger restoration and draft preservation; Escape after forced outside focus loss; cancellation isolation; room/bot error isolation; late-success isolation; late-error isolation. Pending requests are held until the test releases them, so navigation races are exercised deliberately. Browser API failures are controlled fixtures; successful cancellation also checks real isolated-server state.

Run the browser tests with an existing Playwright installation (no package install):

```sh
GBS_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node scripts/testing/schedules-ui-regression.mjs
# Add GBS_QA_HEADED=1 for a visible Chrome run.
# GBS_CHROME_EXECUTABLE can specify Chrome outside its standard macOS path.
```

Isolation: each browser run creates disposable HOME/data/project registry/config and an unavailable test driver, launches its own harness and Vite on ephemeral ports, and blocks conversation-message POSTs and nonlocal browser HTTP traffic. Retries are seeded only while the disposable server is stopped. No paid model or actual user message is sent. Headless run used ports 63737/63738; headed run used 64302/64303. Browser, child servers and temporary state are cleaned in finally. No main checkout, live bot data or live application ports were changed; the only authorized live API operations are the three task-status/review updates.

Native Electron behavior is outside these three repairs and was not tested. Review and approval remain with Yv/Dell; implementation items are not self-approved.
