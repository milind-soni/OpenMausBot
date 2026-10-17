# Current-upstream token check (2026-10-13)

The five-turn short fixture uses the same synthetic bot, two inbox reads and real computer-tool catalog. Completions are scripted; only `/apply-template` and `/tokenize` use Splash. No inference or cache clearing was performed.

| Measure | Upstream `a00ded131` (0.1.108) | Deferred tools and retained history |
|---|---:|---:|
| First complete request | 45,770 | 7,267 |
| Advertised tools | 106 | 15 |
| Five-turn input total | 327,371 | 83,373 |
| Requests including discovery | 7 | 9 |
| Synthetic inbox reads | 2 | 2 |

The initial request is 84.1% smaller; total input is 74.5% smaller. This demonstrates remaining benefit beyond upstream's delivered-context cache fix. It does not establish refreshed wall time, measured KV-cache hits or model quality. The short fixture disables compaction but remains well below its threshold.

Exact captured sources: upstream `a00ded1311365e48f9fc7c74e6185f77a193e78e`, proposed runtime `ebc0c83a05569fac8fb560af1944bd6c3aad464c`, both clean. The final submission adds this documentation after the capture; these counts retain their actual captured revision. The resident tokenizer is Swift-1.5-Qwen3.8-27b Q5_K_S with a 262,144-token window. [Per-request token data](token-efficiency-upstream-refresh-data.json) includes shared-prefix calculations, which are potential cache reuse rather than observed cache hits.

To reproduce the capture against each checkout, use `scripts/benchmark-token-efficiency/capture-session.mjs REPO LABEL OUT short`, then `scripts/benchmark-token-efficiency/measure-captures.mjs CAPTURE OUTPUT` for the tokenizer-only operation. The capture must use disposable data and a synthetic model endpoint. Its fake actions never operate on a real mailbox. The catalog SHA-256 is recorded in the data.

The [2026-10-11 inference report](token-efficiency-benchmark.md) retains its older source revisions and separately reports actual cache usage and request timing. Those historical timings are not measurements against 0.1.108, and the long stress fixtures disable production compaction.
