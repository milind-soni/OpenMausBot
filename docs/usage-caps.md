# Usage caps

A server that runs many bots unattended can use a lot before anyone looks.
Usage caps let its owner set a limit on a day's and a month's usage, for the
whole server and for each bot. They are part of every edition, and none is
set by default: a server whose owner sets nothing behaves as it always has.

## What can be capped

| Setting | Counts | Period |
| --- | --- | --- |
| `dailyUsd` | estimated dollars | the UTC day |
| `monthlyUsd` | estimated dollars | the UTC month |
| `dailyTokens` | tokens | the UTC day |
| `monthlyTokens` | tokens | the UTC month |

Each of the four can be set for the server (everything its bots use
together) and for any one bot. Empty or `0` means no cap. A bot's work counts
against its own caps and the server's; whichever is reached first stops it.

**Dollars** are the usage ledger's figure: what the engine reported, or
tokens times a list price for engines that report none. That figure is
notional when the AI is signed in with a subscription (nobody is billed it),
and `$0` for a model that has no price. **Tokens** always count: a token cap
counts fresh input plus output, the same sum the Usage page's bars show. On a
subscription sign-in, or with unpriced models, cap tokens.

Days and months are UTC, as the usage ledger's are. The reset time is shown
in the server's own time zone.

## What a reached cap stops

`stops` chooses, for all caps together:

- `unattended` (the default once any cap is set): routines, webhooks, app
  events, Bot API calls, and hand-offs in work no person started. A person's
  own message always runs, and so does a routine run they start by hand, a
  webhook's Run now test, and the hand-offs their message leads to.
- `everything`: a person's own messages too, and the helper model's side
  jobs (titles, memory upkeep), which only the server's caps stop.

Nothing is cut off mid-turn. A turn that is running when the cap is reached
finishes; a cap is checked only before new work starts, so the last turn can
take the total past the limit. Work that already started carries on under a
reached cap: a run whose hand-off comes back with its result, one whose owner
answers a card it asked, or one a restart picks up again.

## What a person sees

**At 80% of a cap:** one line in the server log
(`usage cap at 81%: server:day:usd $8.10 of $10.00`), and the cap's bar on
Settings → Usage turns amber with "At 81% of the cap". Nothing else: no
notification, no card.

**When a cap is reached:** one notice in the owner's notifications for that
cap and that period ("Usage cap reached: Unattended work is skipped until
Nov 17, 5:30 AM (Asia/Kolkata): the daily usage cap for all bots ($10.00) is
reached. Your own messages still run."), one line in the server log, and the bar turns red
with when work starts again. The notice is not repeated, however much work is
skipped after it, and not after a restart. No popup, card or approval asks
anything.

Each piece of work the cap keeps from starting leaves one line:

- **A routine's scheduled run** is skipped and counted on one row in the
  routine's run log per cap and period: "Skipped 14 runs: the daily usage
  cap for all bots ($10.00) is reached. Runs start again after Nov 17,
  5:30 AM (Asia/Kolkata)". Each routine keeps its own row. The routine stays
  on and nothing lands under To review. A one-time routine is not used up:
  it stays on, its time moves to when the cap resets, and it runs then.
  A run already queued when the cap was reached (a webhook's, an app
  event's) is let go quietly with the same reason, as a paused bot's is.
- **A hand-off** nobody is waiting on is refused to the bot that asked, which
  says so in one line in its own thread and does not route around the cap.
- **A Bot API call** answers `429` with a `Retry-After` header and
  "This bot has reached a usage cap its owner set, so it takes no new calls
  for now. Try again after …". The call is listed on the bot's Bot API card.
- **A webhook delivery** answers `429` with the reason, and is listed among
  the webhook's deliveries.
- **A person's message**, only under `everything`, is refused with the
  reason in place (`409`, code `spend_cap`).

**At reset:** nothing is announced. When the UTC day or month rolls over,
or the owner raises or removes the cap, covered work starts again by itself:
the next scheduled run runs, the next call is answered. Repeating runs
skipped meanwhile are not made up; a one-time run that waited runs now.

## Where it is set

**Settings → Usage → Usage caps**, shown to the owner only (the `admin`
scope; on a Team Cloud, its admins). The card shows each cap's use now, and
saves `stops`, the server's caps and each bot's.

`config.json`, for a server with no screen:

```json
{
  "usageCaps": {
    "stops": "unattended",
    "server": { "dailyUsd": 20, "monthlyTokens": 500000000 },
    "bots": { "<bot id>": { "dailyUsd": 2, "dailyTokens": 5000000 } }
  }
}
```

The environment sets the server's caps and wins over `config.json`, field by
field; a value that is not a number is ignored:

| Variable | Sets |
| --- | --- |
| `OMB_USAGE_CAP_DAILY_USD` | `server.dailyUsd` |
| `OMB_USAGE_CAP_MONTHLY_USD` | `server.monthlyUsd` |
| `OMB_USAGE_CAP_DAILY_TOKENS` | `server.dailyTokens` (a whole number) |
| `OMB_USAGE_CAP_MONTHLY_TOKENS` | `server.monthlyTokens` (a whole number) |
| `OMB_USAGE_CAP_STOPS` | `unattended` or `everything` |

Per-bot caps are set in Settings or `config.json` only.

The API, for the owner:

- `GET /api/usage/caps`: `{ stops, savedStops, server, bots, env, caps }`,
  where `stops` is the choice in force and `savedStops` the one `config.json`
  holds, `caps` lists every cap in force with `limit`, `used`, `percent`,
  `warn`, `reached` and `resetsAt`, and `env` names what the environment
  holds (`env.values` its values). Settings shows the environment's values in
  the greyed fields, and a save there keeps `config.json`'s own values for
  them, never the environment's.
- `PUT /api/usage/caps` with `{ stops, server, bots }` replaces the saved
  caps. On a server other people sign in to, the change is recorded in
  Settings → Activity like any other settings change.

## With the licensed monthly spend limit

The licensed edition's **Monthly spend limit** (`budgets.monthlyUsd`, the
`budgets` entitlement) is unchanged: it stops every kind of turn, has its own
warning level, and notifies admins at the warning and at the limit. Both read
the same totals from the same engine (`server/usage-caps.ts`). When both are
set, each applies on its own, and whichever is reached first stops the work
it covers. A Bot API call it refuses answers `429` with a `Retry-After`
header up to the start of the next UTC month.

The totals are kept as running sums: a check reads the month's ledger file
once, and after that only the lines appended since, and only when the file's
size or time changed (looked at most every 15 seconds).

## Checks

```sh
pnpm exec vitest run server/usage-caps.test.ts
pnpm exec vitest run server/host/usage-cap-gate.test.ts
pnpm exec vitest run server/usage-caps.e2e.test.ts
```

The last launches the isolated fixture with the scripted engine: a cap set
through the API, a Bot API call refused with `429`, a routine's counted
skipped row, the owner's own message still answered, and the work starting
again once the cap is raised; and a webhook run whose hand-off comes back
after the cap is reached finishing its work.
