# Powering Up OpenMausBot, Chief, Capture, and Android

Research date: 2026-08-26

Scope: local computer/browser control, Android capabilities, secure networking, event-driven connectors, local retrieval/memory, model routing and cost control, observability/evals, and permission/safety patterns. This note is based on the current local OpenMausBot tree plus first-party documentation and specifications.

## Executive recommendation

The strongest version of this system is not one giant agent with access to everything. It is an event-driven personal operations system with four deliberately different layers:

1. **Capture plane:** read-only collectors turn mail, calendar, Drive, Slack, Notion, Plaud, Messages, Monarch, Chrome history, local files, and WHOOP into one durable event format.
2. **Memory plane:** a local, provenance-preserving index deduplicates, links, and retrieves those events without loading the entire life archive into every prompt.
3. **Reasoning plane:** cheap/local models classify and summarize; Chief receives only relevant evidence and uses a stronger model for synthesis and decisions.
4. **Action plane:** APIs perform deterministic actions where available; browser/desktop automation is the fallback; consequential writes require a human confirmation tied to the exact action.

The highest-leverage upgrades, in order, are:

| Priority | Upgrade | Why it matters |
|---|---|---|
| P0 | Replace frequent polling with provider events plus reconciliation | Faster capture, fewer model/tool calls, fewer missed changes, lower cost |
| P0 | Add a durable ingress relay and queue | Events survive sleep, restarts, transient failures, and provider retries without exposing the desktop |
| P0 | Extend the local capture ledger and add hybrid search | Gives Chief one coherent, searchable memory with citations and deduplication |
| P0 | Enforce a per-bot capability matrix | Lets Capture ingest broadly without gaining authority to send, delete, purchase, or publish |
| P1 | Finish the repository's three-tier browser architecture | Makes browser work observable and reliable while isolating login state from the daily browser profile |
| P1 | Turn the Android app into the universal capture/approval surface | One-tap sharing, notification capture, offline queueing, and biometric confirmation |
| P1 | Add model routing, per-run budgets, and batch processing | Preserves high-quality reasoning while substantially reducing routine spend |
| P1 | Add end-to-end traces, source health, and golden-task evals | Makes regressions, missed events, duplicate work, and cost spikes visible |

## Current OpenMausBot baseline

The repo already has unusually good foundations:

- Bots receive isolated workspaces; `MEMORY.md` is intentionally capped at 200 lines/24 KB in the prompt, while longer topic files remain on demand. It also explicitly forbids treating content copied from webhooks/imports/other bots as verified memory. See [`server/workspace.ts`](../../server/workspace.ts).
- Unattended webhook turns cannot inherit auto-approval, host-computer grants are treated separately, and destructive/sensitive patterns force a card. See [`server/auto-approve.ts`](../../server/auto-approve.ts).
- The webhook receiver is separate from the harness, bounds bodies at 256 KB, accepts bearer secrets, supports event filters, records attempts, deduplicates provider delivery IDs, rate-limits events, and caps unfinished work. See [`server/webhook-ingress.ts`](../../server/webhook-ingress.ts) and [`server/webhooks.ts`](../../server/webhooks.ts).
- The Android companion is default-deny: future server routes are unreachable until explicitly added to a narrow allowlist. See [`companion/src/routes.ts`](../../companion/src/routes.ts) and [`android/README.md`](../../android/README.md).
- The app records token/cost usage and keeps an append-only, redacted authorization decision log. See [`src/lib/usage.ts`](../../src/lib/usage.ts) and [`server/decision-log.ts`](../../server/decision-log.ts).
- The new capture ledger already provides transactional runs, per-source cursors/health, a durable Chief outbox, and fail-closed reporting. It is a strong base but does not yet store normalized source items or a retrieval index. See [`server/capture-ledger.ts`](../../server/capture-ledger.ts) and [`skills/capture-ledger/SKILL.md`](../../skills/capture-ledger/SKILL.md).
- The computer-use decision document already describes the right three-tier direction: embedded Chromium, opt-in access to real Chrome through an extension, and a dedicated persistent Playwright profile. See [`docs/computer-use-integration.md`](../computer-use-integration.md).

These safeguards should be extended rather than replaced.

## 1. Build an event-first capture fabric

### Recommended design

Use one normalized envelope for every source:

```text
event_id                 provider's stable delivery/object ID or derived hash
source                   gmail | calendar | drive | slack | notion | whoop | ...
account_alias            work | personal | third
event_type               message.created | event.updated | sleep.updated | ...
provider_object_id       stable remote ID
provider_version/cursor  history ID, sync token, etag, revision, or timestamp
occurred_at               provider event time
received_at               local ingest time
sensitivity               public | personal | confidential | restricted
payload_ref               pointer to encrypted/raw local artifact
content_hash              deduplication and change detection
trace_id                  end-to-end observability key
```

Ingestion should acknowledge quickly, persist first, deduplicate, then enqueue extraction. Model reasoning must never happen inside the provider's webhook request path.

### Which connection path to use

| Source | Preferred event path | Reconciliation/backstop |
|---|---|---|
| Gmail ×3 | Direct Gmail `watch` + Cloud Pub/Sub when sub-five-minute freshness matters | Renew `watch` daily; periodically call `history.list` because Google says notifications can be delayed or dropped |
| Calendar ×3 | Calendar notification channels to a public relay | Incremental sync per calendar; renew expiring channels; notifications carry headers, not changed event bodies |
| Drive | Drive `changes.watch` | Persist page token and periodically reconcile `changes.list` |
| Slack | Slack Events API, narrowly subscribed | Queue immediately and return 2xx within three seconds; dedupe retry IDs |
| Notion | Native Notion webhooks | Verify `X-Notion-Signature`, then retrieve the changed object through the API |
| WHOOP | Native WHOOP webhooks | Fetch the named workout/sleep/recovery object after the event |
| Composio apps | Composio triggers where native integration is not worth owning | Route by `trigger_id`, `trigger_slug`, `connected_account_id`, and `user_id`; monitor account-expiry events |
| Plaud | File-system watcher over the local Plaud Archive | Slow browser/API export sweep only when the archive stops changing |
| Google Messages | Android notification bridge or Messages for Web profile | Periodic browser check while the notification bridge is incomplete |
| Monarch | Dedicated read-only browser profile | Daily balance/transaction reconcile with change hashes |
| Chrome history | Copy the locked History SQLite file, then query the copy | Incremental cursor by visit time; titles/domains only by default |
| Local inbox | File-system watcher | Full directory reconciliation on startup |

Composio is the easiest unified trigger surface, but it is not always the fastest: its official trigger documentation describes Slack/Notion as near-real-time and Gmail/Google Calendar under managed auth as polling with up to roughly 15 minutes of latency. If the five-minute promise is important, use Google's native push mechanisms for Gmail/Calendar and keep Composio for actions and simpler sources. [Composio triggers](https://docs.composio.dev/docs/triggers), [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [Calendar push](https://developers.google.com/workspace/calendar/api/guides/push), [Drive push](https://developers.google.com/workspace/drive/api/guides/push), [Slack Events API](https://api.slack.com/apis/connections/events-api), [Notion webhooks](https://developers.notion.com/reference/webhooks), [WHOOP webhooks](https://developer.whoop.com/docs/developing/webhooks/).

### Stronger ingress pattern: public relay, private desktop

Instead of forwarding a public tunnel directly to the desktop webhook listener, put a tiny Cloudflare Worker in front of a durable queue:

```text
Provider webhook
  -> Cloudflare Worker: validate signature, size, schema, source, replay window
  -> durable queue: retry + dead-letter queue
  -> OpenMausBot outbound pull while online
  -> local capture ledger
  -> queued Capture task
```

This lets the Windows machine sleep without losing events and keeps all inbound Internet traffic away from the harness and companion. Cloudflare Workers support HMAC/signature verification; Queues provide at-least-once delivery, retries, batching, dead-letter queues, and external pull consumers. At-least-once delivery means OpenMausBot must retain its idempotency check. [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Cloudflare Queues](https://developers.cloudflare.com/queues/), [how Queues works](https://developers.cloudflare.com/queues/reference/how-queues-works/), [retry/DLQ behavior](https://developers.cloudflare.com/queues/configuration/batching-retries/).

## 2. Make browser and computer control reliable by design

Use this priority order for every task:

1. Provider API or connector tool.
2. Semantic browser automation using DOM/accessibility references.
3. OS accessibility-tree automation for native applications.
4. Screenshot/vision plus coordinates only when semantic state is unavailable.

The repository's intended three tiers are sound:

- **Embedded browser:** one persistent Electron session partition per bot/source, visible inside OpenMausBot.
- **Dedicated automation browser:** Playwright-managed persistent contexts for Monarch, Plaud fallback, and Messages for Web. Use a separate profile for each trust domain or account group.
- **Daily Chrome opt-in:** extension bridge only for tasks that genuinely need the user's existing session.

Do not attach automation to the default Chrome profile through a remote debugging port. Chrome 136+ deliberately ignores remote-debugging switches against the default data directory because attackers abused that path to extract cookies; Chrome recommends a nonstandard user-data directory. [Chrome remote-debugging change](https://developer.chrome.com/blog/remote-debugging-port/). Playwright persistent contexts store cookies/local storage in a chosen user-data directory, while ordinary browser contexts are isolated from each other. [Playwright persistent contexts](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), [browser-context isolation](https://playwright.dev/docs/browser-contexts).

For every browser action, add four reliability rules:

- Re-snapshot immediately before a write and use a stable semantic locator, never a remembered pixel.
- Assert the expected URL/account/object both before and after the action.
- Attach an idempotency key or precondition where the site/API supports it; otherwise detect whether the intended state already exists before retrying.
- Pause for user takeover on passwords, MFA, CAPTCHA, banking confirmations, purchases, sends, deletes, and publishes.

Record a compact action artifact for debugging: domain, account alias, semantic locator, before/after URL, outcome, duration, screenshot hash, and trace ID. Do not retain full screenshots indefinitely.

## 3. Turn Android into the universal capture and approval remote

Keep the computer as source of truth and keep the companion's current default-deny route design. Add capabilities in this order:

1. **Android share target:** accept `ACTION_SEND` for text, URLs, images, audio, and PDFs; show a confirmation/edit screen, then send the item to Capture. This makes any phone app a one-tap input. Android explicitly recommends validating MIME types, size, and untrusted incoming content. [Receiving shared data](https://developer.android.com/develop/ui/compose/sharing/receive).
2. **Offline outbox:** persist shares, voice notes, and approvals locally; send them through `WorkManager` when network/host constraints are met. WorkManager is Android's recommended library for persistent work and supports constrained, observable chains. [WorkManager](https://developer.android.com/reference/androidx/work/WorkManager).
3. **Opt-in notification bridge:** implement `NotificationListenerService`, with an explicit per-app allowlist and field-level redaction before transmission. It can cover Google Messages and selected high-signal notifications without brittle UI scraping. Android requires the user-granted notification-listener service permission. [NotificationListenerService](https://developer.android.com/reference/android/service/notification/NotificationListenerService.html).
4. **Biometric gate:** require `BiometricPrompt` or device credential immediately before high-impact approvals from the phone. [Android biometric authentication](https://developer.android.com/identity/sign-in/biometric-auth).
5. **Fast capture surfaces:** Quick Settings tile, home-screen widget, notification action, and optional voice-note capture. These should create drafts/events, not execute external actions directly.
6. **Source health dashboard:** show last successful sync, lag, auth expiry, queue depth, duplicate count, and the next reconciliation time for every account.

Do not give a paired phone a generic proxy to the full harness or raw desktop-control routes. A lost phone should be able to be revoked from the computer, and its token should not mint new public webhooks, rotate secrets, or disconnect accounts.

## 4. Add a local, provenance-preserving memory system

`MEMORY.md` should remain the small curated layer, not become the database. Add four local tiers:

1. **Immutable raw artifacts:** original email/event/transcript/notification payload or a bounded excerpt, encrypted at rest when sensitive.
2. **Capture ledger:** normalized event/object rows, source cursors, hashes, relationships, sensitivity, retention, and processing state.
3. **Search index:** SQLite FTS5 for exact names, phrases, senders, dates, and keywords; optional local embeddings for conceptual matches.
4. **Curated memory:** user-confirmed preferences, durable facts, corrections, and pointers to source records; this is what can be promoted into `MEMORY.md`.

SQLite FTS5 provides local ranked full-text search, phrases, prefix queries, NEAR queries, column filters, and BM25 ranking. [SQLite FTS5](https://www.sqlite.org/fts5.html). Ollama exposes a local `/api/embed` endpoint accepting one or many texts, so semantic indexing can remain on the machine. [Ollama embeddings](https://docs.ollama.com/api/embed).

Recommended retrieval pipeline:

```text
query
 -> hard filters: bot, account, source, sensitivity, time window
 -> FTS5 candidates
 -> optional embedding candidates
 -> reciprocal-rank merge
 -> freshness/source-authority boost
 -> deduplicate by provider object + content hash
 -> return short excerpts with provenance links
```

Every retrieved claim should carry source, account alias, object ID, timestamp, and a link/path. Webhook/imported text is evidence, never an instruction. Automatic memory promotion should be limited to facts Chief verified through an authoritative source or the user; corrections need tombstones so a re-import cannot resurrect a rejected fact.

## 5. Route models and cap costs per kind of work

Use a policy router, not one expensive model everywhere:

| Work | Default tier | Escalate when |
|---|---|---|
| Deduplication, routing, labels, urgency | local/small | low confidence or conflicting evidence |
| Extraction from known schemas | small structured-output model | malformed/ambiguous input |
| Daily summaries | small/medium | cross-source conflict or important decision |
| Chief synthesis and planning | strong reasoning model | default already strong; ask user for consequential choices |
| Browser navigation | reliable tool-use model | repeated failure, sensitive write, or unfamiliar site |
| Nightly enrichment/evals | asynchronous batch | only when deadline permits |

Add per-routine controls: maximum input tokens, output tokens, wall time, tool calls, browser actions, retries, concurrent runs, and daily/monthly spend. Coalesce many low-value events into one digest instead of creating one model turn per notification. Cancel duplicate/stale jobs before they start.

Keep stable instructions and tool definitions at the front of prompts and append changing captures later. OpenAI prompt caching reuses matching prefixes; current documentation says cached reads are priced at a fraction of uncached input and recommends tracking cached/write token counts and realized cost. [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). For work that can finish within 24 hours, the OpenAI Batch API offers a 50% discount. [OpenAI Batch API](https://platform.openai.com/docs/api-reference/batch/object).

The largest cost reduction will come from architecture rather than model price: event filtering before inference, local deduplication, retrieval instead of full-history prompts, and small-model extraction before Chief sees anything.

## 6. Add end-to-end observability and behavioral evals

### Trace every run

Emit one trace across:

```text
provider delivery -> signature validation -> queue -> ingest/dedupe
 -> retrieval -> model call -> tool call -> approval -> side effect -> verification
```

Use child spans for each source/API/browser/model operation. OpenTelemetry spans include parent/trace identifiers, timestamps, attributes, events, links, and status; span links are useful when a queued job begins long after the producer request ended. [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/).

Useful low-cardinality metrics:

- capture freshness and reconciliation lag by source/account;
- accepted, duplicate, rejected, retried, dead-lettered, and missed events;
- queue depth and oldest-event age;
- OAuth expiry and webhook/channel renewal failures;
- run success, partial success, timeout, cancellation, and repeated-tool-loop counts;
- approval rate, denial rate, waiting duration, and source/rule;
- input/output/cached tokens and estimated cost by bot/routine/source/model;
- browser steps per successful task and takeover rate;
- memory retrieval precision samples and unsupported-claim rate.

Redact message bodies, tokens, URLs containing capabilities, and screenshot pixels from normal telemetry. Store content hashes and local artifact references instead.

### Build a Grok-to-OpenMaus regression suite

Turn 30–50 representative Grok Bot tasks into golden cases:

- urgent email/calendar detection;
- three-account separation;
- Plaud transcript ingestion and deduplication;
- WHOOP recovery update;
- Monarch read-only summary;
- Google Messages notification capture;
- missed-event reconciliation;
- prompt injection embedded in an email/web page;
- no external send/delete/purchase without confirmation;
- recovery after browser layout, auth, or network failure.

Each case should assert both useful output and prohibited behavior. Run the suite when instructions, connector scopes, browser code, or models change. OpenAI's evaluation guidance describes evals as specified style/content criteria and recommends testing with inputs, analyzing results, and iterating—especially across model upgrades. [OpenAI eval guidance](https://developers.openai.com/api/docs/guides/evals).

Use a five-day shadow period: the new system captures and drafts alongside Grok Bot but does not send or mutate. Compare completeness, timeliness, duplicates, and user corrections before enabling scheduled actions.

## 7. Enforce capabilities outside the model

Create a deterministic matrix keyed by bot × source × account × action:

| Actor | Read | Draft/prep | External write | Desktop control |
|---|---|---|---|---|
| Capture | Approved sources only | Normalize/tag/store | Never | Only isolated read-only collectors |
| Chief | Retrieved evidence and approved apps | Yes | Exact-action confirmation | Ask or isolated profile; host control only while attended |
| Nova/specialists | Task-scoped minimum | Task-scoped | Confirmation or explicit narrow grant | Off unless the task requires it |
| Routine/webhook turn | Read and summarize | Queue a proposed action | Never unattended | Never host auto-control |

Separate read and write credentials where providers permit it. Request OAuth scopes incrementally, per feature, and select the smallest scopes. Google explicitly requires least-privilege scopes, secure token storage, revocation/deletion when unused, and full-featured browsers rather than embedded webviews for OAuth. [Google OAuth policy](https://developers.google.com/identity/protocols/oauth2/policies), [OAuth best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices).

Use a two-phase action contract for consequential work:

1. Agent produces a typed proposal: action, destination, account, data leaving the system, exact payload or diff, cost, and rollback possibility.
2. A deterministic policy engine decides `allow-read`, `ask`, or `deny`.
3. The user approves the exact proposal, preferably biometrically on Android for high-impact actions.
4. Execution receives a short-lived capability token bound to the proposal hash, destination, and expiry.
5. The executor verifies postconditions and writes the result to the decision log.

Do not depend on system instructions as the security boundary. OWASP's agent/MCP guidance calls for least privilege per server/tool, human-in-the-loop for sensitive actions, schema validation, replay protection, isolation, and audit logging; it also says critical authorization controls must be deterministic rather than delegated to the LLM. [OWASP MCP Security](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html), [OWASP system-prompt leakage guidance](https://genai.owasp.org/llmrisk/llm072025-system-prompt-leakage/).

## 8. Secure remote access

For the Android companion, use Tailscale Serve or direct tailnet access, not Funnel. Serve is tailnet-only; Funnel is public Internet exposure. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve), [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel).

Recommended tailnet policy:

- tag the Windows host as the OpenMaus host;
- allow the user's Android device only to companion port 8810;
- deny Android access to harness 8799 and control/admin 8811;
- allow no lateral access to other devices by default;
- use Tailscale grants, which are deny-by-default and support fine-grained source/destination/port rules;
- consider Tailnet Lock after two non-Android signing/recovery nodes are available and the disablement secrets are safely stored.

[Tailscale grants](https://tailscale.com/docs/reference/syntax/grants), [Tailnet Lock](https://tailscale.com/docs/features/tailnet-lock).

For external provider webhooks, use the relay/queue pattern above. If a direct tunnel is used temporarily, expose only the dedicated webhook receiver, never the harness or companion, and verify provider signatures before OpenMausBot sees the payload. Cloudflare Tunnel uses outbound-only origin connections, so no publicly routable desktop address is required. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

## Recommended build sequence

### Phase 1 — foundation

- Upgrade/install OpenMausBot 0.1.38 and import Chief/Capture additively.
- Extend the existing run/source/outbox ledger with normalized event/object records, provenance, hashes, and the common event envelope.
- Add capability policy defaults: Capture read-only, routines/webhooks no unattended writes.
- Connect Gmail/Calendar/Drive/YouTube/Notion/Slack with named account aliases and the narrowest usable scopes.
- Run the existing routines paused/manual only.

### Phase 2 — reliable ingestion

- Add Cloudflare Worker signature adapters plus queue/DLQ and outbound desktop pull.
- Enable Gmail, Calendar, Drive, Slack, Notion, and WHOOP event ingestion.
- Add provider cursors, renewals, dedupe, startup reconciliation, and source health.
- Add local Plaud/inbox/history watchers.

### Phase 3 — memory and routing

- Add SQLite FTS5, provenance, retention, sensitivity filters, and correction tombstones.
- Add optional local embeddings and hybrid retrieval.
- Add small-model extraction, confidence escalation, per-routine budgets, and digest coalescing.

### Phase 4 — browser and Android power

- Finish embedded browser plus dedicated persistent automation profiles.
- Add Android share target, offline outbox, notification bridge, biometric approvals, and health dashboard.
- Add semantic pre/postconditions, browser traces, and human takeover.

### Phase 5 — proving reliability

- Add OpenTelemetry-compatible traces and dashboards.
- Build the Grok regression corpus and injection/safety cases.
- Run five days in shadow mode, correct gaps, then enable only read-only routines.
- Enable each write capability separately after its own observed dry run.

## Bottom line

The most powerful safe target is: **always-on event capture, local searchable memory, cheap automatic triage, strong-model Chief synthesis, and exact human approval at the action boundary**. That architecture will feel faster than the Grok Bot system, cost less than polling every source with a premium model, survive laptop sleep and provider retries, and remain understandable when something goes wrong.
