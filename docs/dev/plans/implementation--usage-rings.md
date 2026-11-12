# Implementation plan: remaining-usage rings and the usage-limit foundation

## Objective

Show how much usage is left on each AI engine the user relies on. The display
is a row of small rings at the top of the app, one per engine in use, filled
to the share remaining.

The same data powers auto-resume and backup-model switching (see
`implementation--scheduled-runs-and-backup-model.md`). This plan therefore
also builds the shared **usage-limit foundation**.

Out of scope:
- Billing or dollar amounts.
- Exact limits where an engine does not report them. We never invent
  numbers.

## Current state

- No usage or limit tracking exists. A search for rate limit, quota, and
  credit across `server/` and `src/` finds nothing.
- Engines in use:
  - Claude Code CLI (stream-json, `server/drivers/claude.ts:369-424`)
  - Codex app-server (JSON-RPC, `server/drivers/codex.ts:245-315`; already
    handles `thread/tokenUsage/updated`)
  - Grok Build (`grokagent.ts` / `grok.ts`)
  - Antigravity via ACP (`antigravity.ts`, `drivers/acp`)
- When an engine runs out of credits today, the turn ends as a generic error
  (`error:` activity) and the bot just stops.

## Phase A: usage-limit foundation (spike first)

1. **Spike (SoSo, 1 day, before coding).** Record what each installed engine
   actually reports. Expected, to be confirmed:
   - Claude Code `2.1.x`:
     - a `rate_limit_event` stream message (status, reset time, possibly the
       utilization share)
     - "usage limit reached … resets <time>" result errors
   - Codex `0.164`:
     - `account/rateLimits/read` and the `account/rateLimits/updated`
       notification (primary and secondary windows with a used percentage and
       a reset time)
     - usage-limit error codes on `turn/completed` or `error`
   - Grok and Antigravity: error text and codes only, probably no live usage.

   The output is captured fixtures under `server/testing/fixtures/usage/` and a
   table in this plan.
2. **`server/usage.ts`**: a normalized store, persisted atomically with
   `json-file.ts`:
   ```ts
   type UsageWindow = { id: string; label: string; remainingPercent: number | null; resetsAt: string | null };
   type EngineUsage = {
     instanceId: string;
     status: "ok" | "low" | "exhausted" | "unknown";
     windows: UsageWindow[];
     source: "reported" | "inferred"; // inferred = from a limit error only
     updatedAt: string;
   };
   ```
3. **Driver hooks.** Each driver emits a `usage` event when it learns
   something (live numbers or a limit error). Each driver also classifies turn
   failures into a new error kind, `usage_limit`, with an optional `resetsAt`.
   Classification is a pure function per engine, tested against the spike
   fixtures.
4. **Refresh.**
   - Update from turn events while bots work.
   - When idle, poll engines that support a cheap read (Codex rate-limits
     read) at most every 5 minutes, and only while the app window is open.
   - Never spend tokens to probe usage.
5. **Event stream.** Add a `usage` frame on the existing SSE stream, plus
   `GET /api/usage` for the initial load.

## Phase B: rings

6. **Design (Z).** Rings sit in the top bar, right side, 18–20px, one per
   engine used by at least one bot.
   - The ring fill is the remaining share of the tightest window.
   - Color: green above 40%, amber at 15–40%, red below 15%, and a grey dashed
     ring for "unknown".
   - The engine logo sits in the center (`ProviderIcons.tsx`).
   - Color is never the only signal: the tooltip and aria-label state the
     number.
7. **`UsageRings` component**:
   - Hover or focus shows a tooltip, for example: "Claude: 62% left in the
     current 5-hour window · refreshes at 3:40 PM. Weekly: 80% left."
   - Click opens a popover with every window, the last updated time, and two
     actions: "Set a backup model…" and "What do these mean?" (opens the
     guide).
   - Exhausted state: a red ring plus "Out until 3:40 PM".
8. **Settings.** Add "Show usage in the top bar" (default on) and a per-engine
   hide toggle.
9. **Plain language.** Say "usage left" and "refreshes at". Avoid "rate limit",
   "quota", and "tokens" in the main UI. The popover can name the technical
   term once for people who search for it.
10. **Guide.** Add `docs/guide/usage-and-limits.md`.

## Verification

- Unit tests:
  - per-engine classifiers against the spike fixtures (limit hit, with and
    without a reset time, unrelated errors not misclassified)
  - `usage.ts` merge, staleness, and persistence
- Component tests: ring math (0, 15, 40, 100%, unknown) and the aria-label
  text.
- Manual (Dell):
  - the real engines show sensible numbers
  - a simulated exhausted engine via the fake CLIs in `server/testing/` turns
    the ring red and shows the reset time
  - the top bar at narrow widths: rings collapse into a single summary ring
    under 900px

## Risks and rollback

- **Engines change their output formats.** Classifiers default to "unknown"
  rather than wrong numbers, and fixtures make regressions visible.
- **Polling costs.** Read-only endpoints only, at a low cadence, and only
  while the window is open.
- **Rollback.** Rings sit behind the Settings toggle. The foundation is
  additive.

## Approval

Status: awaiting user approval
