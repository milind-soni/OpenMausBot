# Refreshed OpenMausBot overnight comparison

These historical inference benchmarks used upstream `978993c8` and proposed PR1 `f4e5f66a`. The October 13 tokenizer check used upstream 0.1.108; it did not repeat inference timings. The submission was subsequently refreshed to upstream 0.1.114: [dated token counts](token-efficiency-upstream-refresh.md), [0.1.109 payload capture](token-efficiency-upstream-0109.md), and [0.1.114 payload capture and verified sources](token-efficiency-upstream-0114.md). Current branch checks are recorded in the submitted PR; the inference measurements below retain their original source revisions.

Timing suite completed at 2026-10-11T08:26:19.605690+00:00. Quality checks: upstream passed, pr1 passed, latest passed.

Compared the upstream snapshot at launch with the proposed deferred-tools plus retained-history PR, intermediate variants, and latest code. All 14 fixed timing traces completed, and their exact capture hashes, helper hashes, source revisions, catalog hashes and request counts were verified.

## Measured results on this Mac

Apple M3 Max, 64 GiB RAM; existing Splash 1.3.1 runner; Swift-1.5-Qwen3.8-27b Q5_K_S; 262,144-token context; int8 KV. No runner restart, configuration change, explicit cache clear, or real mailbox operation.

| Workload | Upstream input / cached | PR1 input / cached | Upstream time | PR1 time | Time saved |
|---|---:|---:|---:|---:|---:|
| 5 turns, simple task (two-run average) | 319,516.5 / 272,096 | 81,922.5 / 71,008 | 4m 30s | 1m 06s | 3m 24s (75.6%) |
| 20 turns, peak 74K–89K | 1,782,674 / 1,371,488 | 1,061,346 / 976,032 | 41m 58s | 6m 13s | 35m 45s (85.2%) |
| 20 turns, peak 191K–220K | 3,409,396 / 2,282,112 | 2,889,724 / 2,658,432 | 123m 19s | 25m 23s | 97m 55s (79.4%) |

The initial simple-task request fell from **44,622 to 7,084 tokens (84.1% smaller)** before replay namespacing. This includes tools, instructions, profile and the first user message; it is not a measurement of system-message text alone. The stress session begins with a large user reference document, so its first request is 17,169 tokens despite the smaller base prompt.

Actual uncached tokens, obtained by subtracting Splash-reported cache reads from all input, fell from 47,420.5 to 10,914.5 for the average short session, from 411,186 to 85,314 for medium, and from 1,127,284 to 231,292 for stress. These reductions are 77.0%, 79.3%, and 79.5%. Total submitted input fell by 74.4%, 40.5%, and 15.2%.

## What upstream already fixes, and where ours still helps

Upstream preserved the cache through the final “Thanks” in both short passes: 46,048 cached tokens out of 46,185–46,186 input, taking 1.47–2.79 seconds. The ordinary per-turn context update issue is fixed in this upstream snapshot.

Upstream still rebuilt its long replay window at turn 15. The measured stress request then had zero cache reads; subsequent requests reused about 43,520 tokens of stable prefix while repeatedly processing roughly 146K tokens of changing history. The upstream structural-prefix calculation independently drops from about 180K at turn 14 to about 43.5K at turn 15. PR1 keeps a matching in-memory protocol history, including tool calls, schemas, results and failures, so later turns append to that history while it remains within its bounds. It has explicit invalidation and fallback rules; this is not unlimited durable context.

Deferral removes unused large tool schemas from the initial request. Retained history also lets the synthetic agent reuse a previously discovered schema: the short script needs one search/describe pair rather than two, and the long script one rather than four. Those decisions are scripted in the timing suite, so they are a controlled mechanism comparison, not proof of how often a natural model will rediscover a tool.

| Variant | Short input / requests / seconds | Medium input / requests / seconds |
|---|---:|---:|
| upstream | 319,513 / 7 / 250.30 | 1,782,674 / 27 / 2517.84 |
| deferred | 93,763 / 11 / 59.52 | Not run |
| wider-deferred | 93,911 / 11 / 72.02 | 1,274,506 / 35 / 361.32 |
| pr1 | 81,918 / 9 / 57.60 | 1,061,346 / 29 / 372.72 |
| latest | 81,954 / 9 / 64.76 | 1,060,913 / 29 / 363.19 |

“Deferred” is tool deferral alone. “Wider-deferred” is an intentionally enlarged replay window plus deferral; it is a counterfactual, not the recommended implementation. Its medium timing is effectively similar to PR1, but it submits 1.27M versus 1.06M tokens and makes 35 versus 29 requests because tool exchanges are not retained in the same way. There is no wider-window-only or deferral-only medium timing, so this is not a fully isolated factorial attribution.

Latest code measured 64.76 seconds short, 363.19 seconds medium, and 1,513.02 seconds stress, close to PR1. This workload does not exercise endpoint configuration UI, compaction, generic auto-review or live approval switching. It cannot establish savings for all six proposed PRs.

## Projected hosted cost, separated from measured Splash timing

| Workload | Resident-prefix scenario, upstream → PR1 | Zero cache reads, upstream → PR1 |
|---|---:|---:|
| short | $0.1466 → $0.0356 | $0.7996 → $0.2060 |
| medium | $1.6911 → $0.3150 | $4.4601 → $2.6576 |
| stress | $3.5724 → $0.8484 | $8.5271 → $7.2282 |

These are hypothetical Sol 6.1 Responses rate-card calculations using the local Qwen tokenizer and scripted output lengths, not actual Sol tokenization, cache hits or bills. Rates checked for this campaign: per million ordinary input $2, cache reads $0.10, writes $2.50, output $10 at ≤272K input. Every request here is below that tier boundary. Reads and writes partition input: a cache write replaces ordinary input charging rather than being added to it. The zero-read scenario still charges eligible cache writes.

The resident scenario uses exact earlier eligible message boundaries (minimum 1,024 tokens) that remain in the lookup window, rather than assuming every shared token is automatically billable as a cache read. The zero-read scenario removes all reads. This provides two explicit residency assumptions; actual provider behavior can differ. Actual Splash cache reads appear only in the measured tables above. Pricing reference: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## Natural-model tool discovery

- upstream: passed; 3 synthetic mail operations.
- pr1: passed; 3 synthetic mail operations.
- latest: passed; 3 synthetic mail operations.

| Variant | Requests | Input / cached tokens | Output (reasoning included) | Model-request time |
|---|---:|---:|---:|---:|
| upstream | 5 | 93,364 / 74,112 | 467 (177 reasoning) | 80.78s |
| pr1 | 6 | 41,211 / 33,408 | 855 (346 reasoning) | 38.74s |
| latest | 6 | 41,132 / 33,376 | 841 (319 reasoning) | 40.19s |

These natural-model timings include prefill and actual generated reasoning/text/tool calls, summed across the three user messages; fixture startup, user waits and tool execution overhead are excluded. They come from one run per variant with a smaller tool catalog than the fixed replay suite. They are supporting capability evidence, not interchangeable with the 5-turn or long-session timing tables.

The quality fixture asks for plain chat, synthetic inbox triage, and a follow-up. Its receipts must show an inbox read, archive of the newsletter, and an unsent draft for the urgent message; unrelated actions and extra follow-up tool calls fail the check. This is a narrow capability probe with unrelated synthetic calendar tools, not an evaluation of real email or computer-use skill.

The original three quality attempts stopped before inference because their fixture selected “low” through a control surface whose compatible driver advertises no effort levels. Failed logs and original helpers remain in quality-setup-failure/. The corrected benchmark proxy explicitly forwards reasoning_effort=low to Splash for every natural-model request and records it. This checks discovery; it does not verify the app’s reasoning-setting UI or driver capability advertisement. Timing replay independently uses reasoning_effort=none and exactly one generated token per request.

## Limits and runner health

Timing replays execute fixed captured requests with one generated token each. Their wall times measure request processing, prefill, cache work and minimal decode, excluding warm-up. They do not measure end-to-end task completion, natural reasoning/output cost, or interactive user delays. Each variant gets a unique constant nonce near the beginning of its tool catalog to reduce cross-variant reuse without clearing the user’s cache; preceding template tokens can remain reusable. The runner has finite shared caches and the environment is not fully isolated. Short upstream/PR1 timings have two passes in opposite relative order; medium and stress have one pass each.

Auto-compaction was disabled and rebuildBytes set to 1,000,000 in disposable captures. The stress peak is about 84% of the 262,144-token capacity. Production normally compacts earlier; this campaign does not prove checkpoint quality, output reserve behavior or production latency near the limit. It specifically exposes long replay-window churn and history retention.

Runner telemetry: 1100 samples; restart counter stayed at [2]; Metal unhealthy=False; critical memory pressure=False. Memory-pressure warnings occurred in 612 samples, and runtime headroom briefly reached 4,408,416 bytes. Allocation refusals/evictions are pressure signals, not by themselves a crash. All fixed traces finished without a runtime or client failure. No native crash replay was needed or performed.

An earlier benchmark preflight incorrectly read the model identity field; that failed before inference and was corrected without changing Splash. Its evidence remains in preflight-model-field-state.json and preflight-model-field-diagnostics/.

## Revisions and evidence

- upstream: `978993c84e2ec17144fcf46e7bfa1e04c9f32a4b`
- deferred: `a71289ea2df26dbb71e2ee68f1178878ed4d55de`
- wider-deferred: `a1a65a47093d61a21158413708b037d69a89d3ff`
- pr1: `f4e5f66aa6b988360f9fd4752f5cce8aa5e62692`
- latest: `e4e44ea2d3a222c6556590aa358a7dce62fc7fb3`

Catalog SHA-256: `ea82be4d6006308275623eeacebe7f179486623c6512b9c331544e1903613f59`.

[Saved per-request timing, token and cost aggregates](token-efficiency-data.json) include all complete traces. Inputs and tool receipts are synthetic. The local private campaign retains the full captures and health traces; no real mailbox or user-app data was used.
