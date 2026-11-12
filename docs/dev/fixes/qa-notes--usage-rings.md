# Usage rings QA (Dell, 2026-11-12)

Outcome: **9 checks pass; freshness labeling needs a fix.** Shared task `3c29da70-873a-4cce-892f-2ac40b9c4126` remains in review. Bug `25ef3b0f-e5db-414a-a6ce-6d7304d4bc55` is filed as normal priority, tagged `gererbuildstudio`, `usage`, `qa`.

Tested dedicated worktree `/Users/esoefildine/Documents/Dev/GBS-worktrees/dell-qa`, detached at `31cd246`. Read its implementation plan and review-board deviations, plus `docs/design/usage-rings.md` from main (the spec is absent in the detached implementation snapshot). No install, branch switch, source edit, or commit in the worktree. Chrome was driven through Playwright against harness `127.0.0.1:8914`, Vite `127.0.0.1:5214`, data `$TMPDIR/gbs-qa-dell-usage`. Seeded `TEST · Codex` and `TEST · Claude`, plus an unused instance to check filtering.

Used temporary copies of `server/testing/fake-codex-app-server.ts` and `fake-claude-cli.ts`, entirely inside the disposable data directory. The Codex copy accepted file-controlled snapshots/notifications and recorded only PID/method names; the Claude copy simulated usage-limit status and logged argv. Added fake `--version` responses and selected Codex's actual fake catalog model `gpt-new` after the initial setup rejected `default`. No live provider was invoked.

| Requested check | Result | Evidence |
| --- | --- | --- |
| 1. Rings for apps in use | PASS | Codex initially showed 62% left and Claude showed unknown with `?`. Unused QA instance had no ring. Claude never displayed a guessed number. |
| 2. Thresholds | PASS | Drove remaining 41, 40, 15, 14, 0, and unknown through fake Codex account notifications. 41 used success stroke; 40/15 warning stroke plus dot; 14 danger stroke, `!`, and `14% left`; zero danger ring with `!` and Out until local time; unknown dashed `2.5 2.5` ring and `?`. Arc offsets matched the remaining share. |
| 3. Tooltip, popover, actions | PASS for fresh readings | Hover/focus tooltip named app, amount left, allowances, and local refresh times. Popover showed both windows, Updated just now / Updated 2 min ago, and affected bot. Guide expanded inline. Set a backup model opened TEST · Codex bot settings. No backup field is expected yet, per the documented deviation. Expired tooltip text has the defect below. |
| 4. Staleness | FAIL in tooltip / accessible label | Server UsageStore masks readings older than 15 minutes and windows past refresh to null/unknown. Browser clock advance beyond 15 minutes removed the ring percentage. With one expired window and one fresh window, ring summary and popover masked the expired percentage, but tooltip and aria-label still exposed it. |
| 5. Responsive summary | PASS | At 899px, only one summary ring was exposed; at 900px, two individual rings returned. Summary opened all-app details. With Codex recovered to 80% and Claude exhausted, summary selected Claude. Healthy Codex also outranked unknown Claude. |
| 6. Keyboard and screen readers | PASS except stale label | Tab/Shift+Tab reached ring; focus showed tooltip. Enter and Space opened details and focused Close. Shift+Tab wrapped to What do these mean; Tab wrapped back. Esc closed and restored ring focus. Known labels spelled out numeric percent plus app/state/time; non-color dot, `!`, dashed pattern and `?` were present. |
| 7. Settings persistence | PASS | Hid Codex, reloaded, verified its ring absent and per-app switch false. Disabled master, reloaded, verified all rings absent and master false. Restored both settings. |
| 8. Exhausted turns | PASS | Explicit fake Codex and Claude turns marked their app exhausted and showed This AI app’s usage ran out. Codex retained a reported reset; Claude correctly had no reset/percentage. A clean direct Codex exhaustion sequence produced one error entry. |
| 9. No inference for usage reads | PASS | Two dedicated reader processes each received only initialize → initialized → account/rateLimits/read. Overall Codex trace contained exactly four turn/start calls, matching four explicitly sent QA messages; settings/reloads/usage notifications created no extra turns. Claude had exactly one inference-shaped invocation (`--include-partial-messages`), matching the one QA send. Its catalog discovery used the existing control-request initialization, not a user prompt. |
| 10. Automated checks | PASS | pnpm typecheck; pnpm test: 42 files / 327 tests; pnpm build. Existing >500 kB chunk advisory only. |

## Necessary fix

**Normal: expired allowance remains in tooltip and screen-reader label.** Bug `25ef3b0f-e5db-414a-a6ce-6d7304d4bc55`.

1. Report Codex ordinaryUsageAllowed=true, a primary five-hour allowance with **33% left** and refresh **60 seconds ahead**, and a weekly allowance with **99% left** and a future refresh.
2. Keep the snapshot in the page without another SSE update. Advance browser time two minutes and allow its 30-second freshness timer to render.
3. Hover/focus the ring and open details.

Actual: ring selects fresh weekly 99%, and popover says Not reported for the expired five-hour allowance. Tooltip and aria-label still include `5-hour allowance: 33 percent left, refreshes at [past time]` (tooltip uses `%`). This contradicts the fresh display and exposes an expired percentage.

`src/lib/usage.ts` `usageLabel()` maps raw `engine.windows` without the freshness filtering used by `usageView()` and `UsagePopover`. Apply the same window freshness rules to tooltip/accessible copy, including sparse-update cases where one window is older than 15 minutes while another remains fresh. Do not discard valid fresh windows.

A duplicate error observed during the first exhaustion attempt was traced to the temporary fake completing twice with an outstanding approval request. Retesting the repository's direct exhaustion sequence yielded one error; no app bug was filed for that setup artifact.

## Scope and cleanup

These are fake-engine integration checks, not claims about a real account's allowance or reset guarantees. Contract-based design deviations were respected. Existing board checkbox marks were left unchanged. The shared task API on 8899 was used only for the authorized task read/update and bug creation; live processes, real bots, and `~/.gbs` were not touched directly.

Chrome QA session, isolated harness, and Vite stopped; `$TMPDIR/gbs-qa-dell-usage` removed. Only this report was committed on main; nothing pushed.
