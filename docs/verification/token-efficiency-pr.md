# Defer large tool catalogs and retain chat tool history

This saved proposal records the earlier reconstruction and its historical measurements.
The October 13 refresh used upstream `a00ded131` (0.1.108). Later submission work uses upstream 0.1.114; see [the dated current-base capture](token-efficiency-upstream-0114.md) and the submitted PR for current branch checks. All reconstruction bases and test counts below are historical; the inference campaign was not repeated.

## What changed

A simple connected bot currently receives unused large tool schemas on every request. Rebuilding its next request from visible chat also discards the exact tool exchanges that discovered and used those tools. This PR extends deferred discovery to command and built-in catalogs and retains bounded protocol history across continuous chat turns.

Large authorized catalogs (more than 40 tools or 8,000 serialized bytes) expose search, description and validated execution tools. Small catalogs remain direct. The original instructions and schema are available on demand; execution still uses scope checks, original-schema validation, approvals and cancellation. New large integrations inherit deferral automatically.

History is retained only for a matching canonical branch, model, standing prompt, permissions and catalog. It includes failures and denials, preserves delivered context notes, and falls back to durable canonical chat on restart/invalidation. A definite context-limit rejection can retry once before any output or operation. This complements upstream's delivered timestamp/context-note fix.


## Why

Local connected bots pay for a large unused catalog before doing useful work. Keeping the actual tool conversation also avoids rediscovery and repeated prefill in longer sessions, while preserving upstream's normal per-turn cache fix.

### Refreshed benchmarks

Measured on an M3 Max/64 GiB Mac with Splash 1.3.1 and Swift-1.5-Qwen3.8-27b Q5_K_S, 262,144-token capacity. These are fixed request replays with one output token each; times measure prompt/cache work, not complete task execution.

| Synthetic workload | Input tokens, upstream → PR | Actual uncached tokens, upstream → PR | Measured wall time, upstream → PR |
|---|---:|---:|---:|
| Simple, 5 turns (two-run average) | 319,517 → 81,923 | 47,421 → 10,915 | 270.17s → 65.96s (75.6% less) |
| Medium, 20 turns | 1,782,674 → 1,061,346 | 411,186 → 85,314 | 2,517.84s → 372.72s (85.2% less) |
| Large, 20 turns | 3,409,396 → 2,889,724 | 1,127,284 → 231,292 | 7,398.52s → 1,523.38s (79.4% less) |

Discovery adds two requests in each comparison (7 → 9 for short, 27 → 29 for medium/large); the measured prefill savings outweigh those extra rounds on this setup.

The first complete simple request is 44,622 → 7,084 local tokenizer tokens (84.1% less). Upstream's final “Thanks” preserved 46,048 cached tokens in both short passes. Long upstream history starts shifting at turn 15, repeatedly replacing a large prefix; retained history preserves it within its bounds.

Hypothetical Sol 6.1 Responses costs with exact eligible cached boundaries and retained cache residency are $0.1466 → $0.0356 (short), $1.6911 → $0.3150 (medium), and $3.5724 → $0.8484 (large). With zero reads they are $0.7996 → $0.2060, $4.4601 → $2.6576, and $8.5271 → $7.2282. Input reads/writes/ordinary processing are partitioned correctly, including cache-write charges. These use Qwen token units and scripted output; they are projections, not measured Sol bills.

All three natural-model synthetic triage checks passed (upstream, this PR and latest code): inbox read, newsletter archive, unsent urgent draft, no unrelated action. The proposed PR used 41,211 input tokens and 38.74s of model-request time versus upstream's 93,364 and 80.78s, with more discovery/reasoning output (855 versus 467 tokens). This is a small supporting capability probe, not broad quality parity.

### Interpretation and limits

The timing baseline is upstream `978993c8`; the submission is reconstructed on newer upstream `7ea18ea4`. The newer reconstruction has separate code checks, not a repeated inference campaign. The long fixtures disable compaction and retain large synthetic reference documents. Raising the replay window plus deferral also performs well: 361.32s medium, versus 372.72s here, but submits 1.27M versus 1.06M tokens with 35 versus 29 requests. That counterfactual is not an independent attribution of every component.

Latest combined code measured 64.76s/363.19s/1,513.02s for short/medium/large. This workload does not exercise the other five changes, so those numbers must not be described as all-six-PR savings. The combined deferred-tool/history benefit belongs to this PR.

Full methods, source revisions, actual cache usage, pricing assumptions and limitations: [benchmark report](token-efficiency-benchmark.md) and [data](token-efficiency-data.json).

## How it was verified

Mac arm64, Node 24. Focused suite: **284 passed**. App and server TypeScript checks and warning-free lint passed on this reconstruction branch.

```sh
pnpm exec vitest run server/drivers/chat-mcp-tools.test.ts server/drivers/openai-chat.test.ts server/drivers/openai-chat-context.test.ts server/drivers/openai-chat-catalog.test.ts server/drivers/openai-chat-tools.test.ts server/mcp-directory.test.ts server/token-efficiency.e2e.test.ts server/cache-continuity.e2e.test.ts scripts/measure-chat-tokens.test.ts
pnpm typecheck
pnpm lint
```

Benchmark helper tests: **10 passed**. Saved local inference is described above; no inference was rerun during reconstruction.

Combined full Vitest coverage: **14,591 passed**, 72 skipped and 1 todo across **1,113 files**. Seven initial failed files exposed four preparation issues (Node suites picked up by Vitest, a stale retry entry, a missing documentation link and a fake importing production code) plus an intermittent cloud guest timeout. The preparation issues are corrected and affected whole-file checks pass; all 10 Node benchmark tests pass separately. The exact guest timeout also reproduced on untouched upstream; its whole 11-case file passes on our branch. Broker, Electron Node and packaged-server tests, native approval-mode smoke, isolated UI, offline evals and additional static/build checks passed separately. Failed/interrupted evidence is retained: this is full coverage plus targeted reruns, not a claimed completely green `pnpm test` invocation. Each branch also passed focused tests, app/server types and lint.

### Dependency / related PRs

First in the six-PR sequence, based on upstream `7ea18ea4`. The context-window and cumulative-compaction changes build on this runtime. Later approval changes have separate behavioral validation; their benefit is not included in the token savings table.

## Screenshots (UI changes)

No renderer change.

## Checklist

- [x] `pnpm typecheck` passes locally.
- [x] Full `pnpm test` coverage and affected-file reruns verified; intermittent upstream fixture failure documented above.
- [x] Server behavior changes have deterministic regression/fixture tests.
- [x] No tracked `dist-server/` edits.
- [x] No new ungated platform code or `shell: true` / cmd.exe command construction.
- [x] Included evidence is synthetic; credentials and user data are excluded.
