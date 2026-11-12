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

## Phase A spike findings — SoSo, 2026-11-12

Research only: no usage tracking, polling, error handling, or UI behavior was added.
Installed versions: Claude Code **2.1.312**, Codex **0.164.0**, Grok Build
**1.0.70 (f50904eaee6c)**, Antigravity **1.5.6**. Evidence is in
`server/testing/fixtures/usage/README.md`. Only one account read was made
(Codex); no model turns or intentional exhaustion probes were run.

| Engine | What is reported | Fields / error signals | Reset time available? | Cheap read spending no model tokens? | Recommendation |
|---|---|---|---|---|---|
| Claude Code 2.1.x, stream-json | Optional usage event; assistant error category; result error text | `rate_limit_event.rate_limit_info`: `status`, optional `utilization`, `resetsAt`, `errorCode: credits_required`; assistant `error: rate_limit` or `billing_error`; result `errors[]` | Optional `resetsAt`; not guaranteed on credit rejection | No dedicated headless account-read command in installed help. `/usage` is a local command, but its machine-readable output was not validated here | Passive live ring only when a usable utilization value is actually reported; otherwise **unknown**. Do not start turns to refresh it |
| Codex 0.164.0, app-server | Account snapshot and rolling notifications, with primary/secondary windows | `account/rateLimits/read`; `account/rateLimits/updated`; `usedPercent`, `windowDurationMins`, `resetsAt`, `credits`, `rateLimitReachedType`, `ordinaryUsageAllowed`; `codexErrorInfo: usageLimitExceeded` | Yes: nullable Unix seconds on each window | **Yes**, verified `initialize` → `initialized` → `account/rateLimits/read`, without any thread or turn | **Live ring** for reported windows; prefer the per-limit map, and retain unknown for missing windows |
| Grok Build 1.0.70, ACP | Persisted per-session consumption is available; installed binary recognizes exhaustion and throttling categories | `grok usage <SESSION_ID> [TURN]`; strings `usage_pool_exhausted`, `usage_limit_reached`, `rate_limited`, `global_rate_limit`, `concurrency_limit` | Account reset exists in the product, but no CLI/ACP reset field was established | `grok usage` reads consumption without inference; **no verified remaining-account-usage RPC** | **Unknown**. Session consumption is not remaining subscription usage; error strings alone do not establish wire format |
| Antigravity 1.5.6 | Interactive `/usage` refreshes model-group quotas; embedded backend descriptors include grouped buckets | `remaining_fraction`, `reset_time`, `refresh_window_label`, `disabled`; `RESOURCE_EXHAUSTED`/quota/retry types exist in binary | Backend bucket has protobuf Timestamp; no validated print/ACP reset payload | Interactive `/usage` reads quota; **no verified headless/ACP quota-read RPC** | **Unknown** in the current integration until a supported read or actual structured quota event is demonstrated |

### Contract details and limits of the evidence

**Claude.** The [official SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent)
provides the event shape. Credits-required fields need 2.1.181+, and warning
`overageEnabled` needs 2.1.295+. Result subtype `error_during_execution` is
not itself an exhausted-usage signal; neither are `overloaded` or a local
budget stop. No real limit event was captured. The published numeric type
alone does not establish utilization scaling or reset units: validate those
against a real event before calculating percentages or scheduling resumes.
The constructed fixture deliberately includes a rejection with neither a
percentage nor a reset.

**Codex.** [Official OpenAI documentation](https://developers.openai.com/codex/app-server/#rate-limits-chatgpt)
and the installed CLI’s generated types agree on read/notification methods.
The observed read contains 300-minute and 10,080-minute windows. Compute
remaining share as `clamp(100 - usedPercent, 0, 100)` for a reported window;
never assume all accounts use those durations. Account/reset-credit IDs are
redacted. This is a snapshot, not a promise that the next request succeeds.
The generated notification type explicitly describes sparse updates: merge
available values or refresh the full snapshot rather than clearing known
account metadata on a null notification field.

`error.params.error.codexErrorInfo` and
`turn/completed.params.turn.error.codexErrorInfo` can identify
`usageLimitExceeded`. `rateLimitExceeded` is separate; `contextWindowExceeded`
and `sessionBudgetExceeded` are not subscription exhaustion. Turn errors
have no typed reset field; obtain window reset times from the account read.
`rateLimitReachedType` distinguishes ordinary limits from owner/member credit
and spend limits. `credits.hasCredits: false` alone does not mean exhausted
included usage (the observed read also has `ordinaryUsageAllowed: true`).
Do not infer recovery from a past reset or a percentage: the read contract
says to use backend permission when available. API-key/unsupported auth
failures must leave usage unknown. No real limit error was induced.

**Grok.** [Official headless/ACP documentation](https://docs.x.ai/build/cli/headless-scripting)
establishes the transport, not an account-usage endpoint. Installed help
explicitly describes `grok usage` as persisted token/cost consumption.
[The product FAQ](https://docs.x.ai/grok/faq) describes account percentages,
weekly resets, and extra credits in its Usage view; that does not establish
an ACP contract. Binary category strings are saved as evidence, not invented
RPC envelopes. Their nesting, numeric codes, and reset metadata remain
unverified. Do not label concurrency limits as an empty weekly pool.
The optional API-backed `server/drivers/grok.ts` is a separate billing path;
API request/consumption metrics cannot stand in for the Build subscription.

**Antigravity.** Correction to the original assumption: this repository’s
`server/drivers/antigravity.ts` currently runs **print stream-json**, not ACP.
The installed CLI now also offers `agy acp`.
[Google’s usage documentation](https://antigravity.google/docs/cli/commands/usage)
describes an interactive backend refresh, while
[the ACP guide](https://antigravity.google/docs/cli/acp) documents the
transport without a quota-read method. Embedded protobuf metadata confirms
richer quota information exists internally, but not that it is emitted to
this app. No exhausted print/ACP response was captured, and no numeric
ACP error code or reset field is asserted. Generic resource exhaustion can
be transient; it is insufficient to promise a reset or trigger billing advice.

### Implementation recommendation

Proceed with Codex account reads and passive Claude events in the later
implementation. Keep Grok and Antigravity unknown until their supported
account contracts are established. Never poll with model prompts, scrape
login secrets, use session totals as an account balance, or convert a generic
429 into a weekly-limit reset. Every constructed example and unverified
transport mapping is labeled in the fixture inventory.

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

Status: approved by the user on 2026-11-12
