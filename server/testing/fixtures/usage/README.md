# Engine usage research fixtures

Collected 2026-11-12. Research artifacts only; no application hooks are added.
No raw credentials, account IDs, home paths, session transcripts, or prompts are included.

| File | Provenance | Purpose / limitations |
|---|---|---|
| `codex-read-observed.json` | Actual Codex 0.164.0 account read; account and reset-credit IDs replaced | Snapshot from the sole live read. No thread/turn was started. Numbers are observations, not test expectations for another account. |
| `codex-0.164-contracts.txt` | Selected types from installed `codex app-server generate-ts` | Exact local read/update/error contracts. Full temporary generated tree was deleted. |
| `codex-notifications-schema-examples.json` | Constructed notification/error examples using those types | Not live failures. Update uses the observed snapshot as illustrative input. |
| `claude-events-schema-examples.json` | Constructed examples from official SDK documentation; installed CLI 2.1.312 corroborates event names | Not captured events. Numeric conventions need real-event validation. Result object is an excerpt, not a complete wire message. |
| `grok-binary-observations.json` | Read-only installed 1.0.70 help and binary-string inspection | Evidence only. Not an RPC payload; no nesting, numeric error code, or reset field is established. |
| `antigravity-binary-observations.json` | Read-only installed 1.5.6 protobuf-descriptor inspection | Backend schema evidence only. Does not establish a print/ACP quota message or account endpoint. |

Reproduction uses `--version`, `--help`, `grok usage --help`, `grok agent --help`,
`codex app-server generate-ts --out <temporary-directory>`, and bounded mmap
searches of the installed executables. Do not dump entire binaries or user logs.
The read request was `{"id":2,"method":"account/rateLimits/read","params":{}}`
after the ordinary app-server initialization handshake over stdio. Only this
read contacted an account endpoint; no inference requests were made.

Sources and recommendations are in
[`implementation--usage-rings.md`](../../../../docs/dev/plans/implementation--usage-rings.md).
Unobserved error shapes remain explicitly unverified; examples must not be
presented as live captures or used as proof of account entitlements.
