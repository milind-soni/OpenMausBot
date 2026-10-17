# Tool-efficiency capture on upstream 0.1.114

Measured October 16, 2026 using the same five-turn synthetic session, a fixed computer-tool catalog, fake completions and a disposable server on each side. No real inbox or model inference was used.

| Measurement | Upstream | Deferred tools and retained history |
|---|---:|---:|
| Advertised tools | 108 | 15 |
| First request, UTF-8 JSON bytes | 194,928 | 29,492 |
| Total request bytes | 1,394,375 | 351,484 |
| Requests, including discovery | 7 | 9 |
| Synthetic inbox reads | 2 | 2 |

Initial bytes fell 84.87%; total bytes fell 74.79%. Counts include the two extra discovery requests. Upstream source: `d54311a918b9f2fd02fc9b51f146b4d6d47ec860`. Standalone feature source: `fd49e07c0a0602461166cbfb8bd972a82747adb3`. Both sources were clean when captured. The accompanying data file records the shared catalog SHA256.

These are serialized request bytes, not native token counts, cache hits, latency, paid API costs or a model-quality evaluation. Automatic compaction was disabled for the controlled fixture; this short capture does not establish long-session compaction behavior. The older tokenizer and fixed-replay timing reports retain their original sources and dates and must not be presented as current-version timing results. This comparison covers PR1, not savings from all six features.

Reproduce with `scripts/benchmark-token-efficiency/capture-session.mjs`, workload `short`, against each source, using the same read-only `OMB_COMPUTER_CATALOG_FILE`. Real tool selection remains covered separately by behavior tests and historical model evaluations.
