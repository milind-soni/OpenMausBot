# OpenMausBot monthly operating cost

**Estimate date:** 2026-08-26
**Scope:** One Windows OpenMausBot installation; Chief/Capture routines; three Gmail accounts, three calendars, Drive, browser/local capture (Plaud, Google Messages, Monarch, Chrome history, YouTube, WHOOP, and a local inbox); Cursor driving Grok 4.6; optional ASCII Box and optional Composio/Cloudflare relay; Android companion.

## Shane's actual plan correction

Shane has Cursor Ultra through his existing Grok Heavy subscription. Treat that
subscription as already paid rather than adding Cursor Pro to OpenMausBot's
monthly cost. Cursor currently documents $400 of included API-agent usage plus
bonus usage on Ultra, and separately identifies Cursor Grok 4.6 as part of the
included Cursor Models pool. The modeled OpenMaus usage below—about $7, $23, or
$70 of API-equivalent inference for low, normal, or heavy operation—fits within
that $400 allowance.

Therefore the revised expected **incremental OpenMausBot model cost is $0/month
in all three modeled scenarios**, provided the Cursor Spending dashboard shows
these OpenMausBot calls drawing from the included Ultra pool and on-demand
usage has not been separately enabled. Grok Bot's own weekly allowance is a
separate entitlement; if both Cursor and SuperGrok subscriptions are present,
SpaceXAI says Grok Bot uses whichever has more usage.

Revised incremental totals for Shane:

| Deployment | Low | Normal | Heavy |
| --- | ---: | ---: | ---: |
| Local-first OpenMausBot | **$0** | **$0** | **$0** |
| Composio Pro + Cloudflare Workers Paid | **$34** | **$34** | **$34** |
| Above plus weekday ASCII Box | **$54** | **$54** | **$54** |

Composio Free plus Cloudflare's free tiers may also keep a development remote
stack at $0 incremental. Check Cursor **Dashboard → Spending** after the first
week; the dashboard is authoritative for which pool is being consumed.

## Bottom line

If the existing Cursor individual subscription is treated as already paid, the likely **incremental** cost is approximately:

| Operating mode | Incremental over an existing Cursor Pro subscription | Including the Cursor Pro subscription |
| --- | ---: | ---: |
| Low / mostly local | $0/mo | **$20/mo** |
| Normal / recommended | ~$3/mo | **~$23/mo** |
| Heavy / many AI escalations | ~$50/mo | **~$70/mo** |

Those figures assume deterministic polling and local/browser diffing, with AI invoked only for new or important events. Calling Grok on every five-minute poll would make the heavy case substantially higher and is not the design to use.

The optional remote-ready stack adds roughly **$34/mo** (Composio Pro $29 + Cloudflare Workers Paid $5), producing about **$54 / $57 / $104 per month** in the three scenarios. Adding an ASCII Box default VM during the weekday watch window adds **$20/mo** in practice because Box has a $20 account minimum; the combined remote + Box totals are about **$74 / $77 / $124 per month**.

Taxes, any existing Gmail/Google Workspace, Plaud, Monarch, WHOOP, YouTube, mobile data, internet, and Windows-PC electricity are excluded because they are pre-existing or plan-dependent rather than OpenMausBot charges.

## Assumptions and formulas

The requested fast watch runs from 08:00 through 19:55 every five minutes on weekdays: 144 cycles per weekday. At 22 weekdays/month this is **3,168 cycles/month**. The hourly refresh runs 08:45 through 19:45: 12 cycles per weekday, or **264 cycles/month**. Total scheduler cycles are therefore **3,432/month**.

The architecture assumed here does not send every cycle to an LLM. It locally fingerprints source state, suppresses unchanged results, batches related changes, and escalates only meaningful changes. Estimated model evaluations:

| Scenario | AI evaluations/month | Per evaluation (uncached planning assumption) | Grok-equivalent token cost |
| --- | ---: | ---: | ---: |
| Low | 120 | 20k input + 3k output | 120 × ($0.040 + $0.018) = **$6.96** |
| Normal | 400 | 20k input + 3k output | 400 × ($0.040 + $0.018) = **$23.20** |
| Heavy | 1,200 | 20k input + 3k output | 1,200 × ($0.040 + $0.018) = **$69.60** |

The calculation uses xAI's published Grok 4.6 API rates of $2 per million input tokens and $6 per million output tokens. Cursor's actual invoice is authoritative when Grok is used through Cursor; included usage, bonus capacity, plan, caching, context size, and any on-demand rules can change the result. The estimate intentionally uses the uncached rate, so prompt caching can lower it.

For an individual Cursor Pro account, the model cost is compared with the plan's included usage: low remains within the included amount; normal is approximately $3.20 over the $20 allowance; heavy is approximately $49.60 over it. Rounded totals are shown above. If the account is Pro+ or Ultra, the fixed subscription and included usage change; check the Cursor billing dashboard before changing plans.

## Cost components

### Cursor + Grok 4.6

Cursor currently lists individual plans at Hobby $0, Pro $20/mo, Pro+ $60/mo, and Ultra $200/mo. Cursor documents that individual plans include a model-usage pool and that on-demand usage can continue after the included amount; usage depends on model and token consumption. Cursor's model documentation lists Grok 4.6 as available in Cursor. xAI documents Grok 4.6 at $2/M input, $0.50/M cached input, and $6/M output for prompts below 200k tokens (long-context rates are higher).

Sources: [Cursor plans](https://prod.cursor.com/help/account-and-billing/pricing), [Cursor usage/pricing details](https://docs.cursor.com/account/pricing), [Cursor model list](https://cursor.com/docs), [xAI Grok 4.6 pricing](https://docs.x.ai/developers/models/grok-4.6), [xAI cost tracking](https://docs.x.ai/developers/cost-tracking).

### Local computer, browser, and capture work

No per-call cloud fee is assumed for local Windows CUA, local filesystem capture, Chrome history, or a locally controlled browser. The costs are the PC, power, and the user’s existing service subscriptions. Browser automation that uses a paid hosted provider is a separate optional line item; keep it off the default path when the local browser is available.

### Composio

Composio's current Free plan is $0 with 100,000 own-app/API-key/MCP tool calls per month, 50,000 trigger events, and unlimited own-app connections. Its Pro plan is $29/mo and includes $29 of usage credit plus spend caps and add-ons. Composio-managed apps have a smaller included allocation (up to 20,000 of the free tool-call allowance) and then usage charges; use the user's own OAuth applications where practical.

At the stated schedule, even seven remote source checks per scheduler cycle would be 3,432 × 7 = **24,024 tool calls/month**, below the 100,000 own-app allowance. That means Composio can be **$0** for this workload when using own app credentials and standard tools. Budget $29/mo only if its managed connections, paid features, spend controls, or premium browser/search tools are specifically needed.

Sources: [Composio pricing](https://composio.dev/pricing), [Composio pro tools](https://docs.composio.dev/toolkits/pro-tools).

### Cloudflare relay

Cloudflare Tunnel is available on all plans, so a private outbound tunnel from the Windows host can be $0. Workers Free includes 100,000 requests/day. Workers Paid has a $5/mo account minimum and includes 10 million requests/month plus 30 million CPU milliseconds; the listed workload is far below those allowances if the relay does lightweight routing. R2 has 10 GB-month, 1 million Class A, and 10 million Class B operations free each month. Queues Free includes 10,000 operations/day; Paid includes 1 million/month, then $0.40/million operations.

Recommended budget: **$0** for Tunnel + Free Workers/Queues/R2 during development; **$5/mo** for the Paid Workers plan when production reliability, higher limits, or paid bindings are desired. Domain registration and a paid domain plan are not included.

Sources: [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

### ASCII Box (optional)

Box bills by VM-second. Its published price is $20 for 2,000,000 VM-seconds, approximately 555 hours of a default 4-vCPU/8-GB VM; small is 0.5× and large is 2×. Stopped boxes pause billing, but the account has a $20 monthly minimum.

The weekday watch window is 264 hours/month. A default Box used only during that window is 264 × ($20 / 555) = **$9.51**, but the account minimum makes the bill **$20**. A default VM left running 24/7 is 720 × ($20 / 555) = **$25.95**. A large VM left running 24/7 is approximately **$51.89**. Use Box for isolated browser/agent work, not for the always-on local watcher unless isolation is worth the premium.

Source: [Box by ASCII pricing](https://box.ascii.dev/).

### Android companion

For a private companion using Firebase Cloud Messaging, Crashlytics, Analytics, and Remote Config, Firebase lists these products under its no-cost Spark plan (subject to quotas). Publishing to Google Play requires a one-time $25 developer registration fee; it is not a monthly operating cost. A self-distributed closed app can use Android Developer Console limited distribution without the registration fee, limited to 20 devices.

Sources: [Firebase pricing](https://firebase.google.com/pricing), [Google Play Console registration](https://support.google.com/googleplay/android-developer/answer/6112435), [Android Developer Console distribution](https://support.google.com/android-developer-console/answer/16640817).

## Scenario totals

These totals use Cursor Pro as the active plan and include its subscription. “Remote-ready” adds Composio Pro and Cloudflare Workers Paid. “Remote + Box” adds a weekday-window default Box account; it is shown as $20 because of Box's minimum.

| Scenario | Cursor Pro + model usage | Local-only total | Remote-ready total | Remote + Box total |
| --- | ---: | ---: | ---: | ---: |
| Low | $20 | **$20** | **$54** | **$74** |
| Normal | ~$23 | **~$23** | **~$57** | **~$77** |
| Heavy | ~$70 | **~$70** | **~$104** | **~$124** |

If Cursor Pro is already paid, subtract $20 from the local-only totals and from every combined total. If Box, Composio, or Cloudflare are already paid for other projects, treat those as sunk too and subtract only the incremental usage.

## Cost-control design decisions

1. Keep five-minute polling deterministic and local; use hashes, timestamps, and source cursors to avoid an LLM call for unchanged data.
2. Batch updates from the three Gmail accounts and three calendars into one model evaluation per meaningful window.
3. Prefer direct Google APIs or Composio own-app connections over Composio-managed apps when feasible.
4. Use local Chrome/browser control first; invoke a paid hosted browser task only when the local session cannot perform the operation.
5. Stop Box VMs outside the active browser/agent task and set Cursor/Composio spend caps.
6. Log input/output/cache tokens and cost per routine. xAI responses expose exact per-request cost through `cost_in_usd_ticks`; Cursor's usage dashboard should be the source of truth for Cursor-routed calls.

## Caveats

- The user’s actual Cursor plan, usage pool, bonus capacity, and on-demand spending setting are not visible in this report. Verify them in Cursor billing before enabling heavy routines.
- The Grok 4.6 API rate is a proxy for estimating Cursor model usage; Cursor may apply its own plan accounting, routing, discounts, or token-rate rules.
- Google, Plaud, Monarch, WHOOP, YouTube, mobile carrier, and internet costs depend on existing plans and are not safely inferable from the app configuration.
- Browser/search/image/video premium tools can dominate the bill if used frequently. Their usage should be separately metered and capped.
- Cloudflare and Composio prices can change; the linked first-party pricing pages are the current source of truth.
