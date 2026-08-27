

<parallel_dev_learnings>
<!-- Last updated: 2026-08-28 01:58 -->
<!-- Sources harvested from 2 worktree(s): -->
- `.parallel-dev/logs/codex%2F006-recover-degrade/branch-notes.md` (branch: codex/006-recover-degrade, phase: auto-detect)
- `.parallel-dev/logs/codex%2F007-dingtalk-stream/branch-notes.md` (branch: codex/007-dingtalk-stream, phase: auto-detect)

## Architecture Decisions

### Vendor Stream SDK is isolated and version reality is explicit
- Context: The planned exact `dingtalk-stream@2.1.6` does not exist in npm, while the package `latest` tag resolves to a prerelease.
- Choice: Pin registry-published `2.1.6-beta.1` exactly, isolate the only import in `stream-sdk.ts`, verify its installed declarations/source, disable debug, and rely on its built-in reconnect.
- Rejected alternatives: A nonexistent lock entry, dynamic `require`, guessed multi-version shims, and silent fallback to an older release were rejected because they make builds or runtime behavior unverifiable.
- Consequence: This adapter is limited to the non-production milestone until a stable version is evaluated; package API changes remain contained in one bridge.
  <!-- source: codex/007-dingtalk-stream -->

### Stream acknowledgement follows durable core commit
- Context: DingTalk redelivers callbacks when ACK is absent or late, while ACK-before-persist can lose task state.
- Choice: Normalize, invoke the collaboration/Owner sink, and ACK only after committed success or duplicate; parse and persistence failures remain unacknowledged.
- Rejected alternatives: ACK on callback receipt and coupling replies to ACK were rejected because both can lose authoritative state.
- Consequence: Internal idempotency converges redelivery and outbound replies/cards flow independently through delivery ports.
  <!-- source: codex/007-dingtalk-stream -->

### Ephemeral reply URLs never become collaboration data
- Context: `sessionWebhook` is short-lived and secret-bearing, whereas proactive conversation identity is durable and semantically distinct.
- Choice: Keep validated DingTalk HTTPS session URLs only in an in-memory TTL registry, disable redirects, and fall back solely to an explicit proactive target.
- Rejected alternatives: Persisting webhooks in the Ledger/outbox or deriving proactive IDs from inbound conversation IDs were rejected as secret leakage and routing ambiguity.
- Consequence: Restart intentionally drops session routes; delivery then uses configured proactive routing or reports `delivery_unroutable` without changing Work Item state.
<!-- Record every non-trivial design choice made in this worktree.
     Format: ### <decision title>
     - Context: why did this decision arise?
     - Choice: what was chosen?
     - Rejected alternatives: what else was considered and why rejected?
     - Consequence: what does this lock in or enable?
-->
  <!-- source: codex/007-dingtalk-stream -->

## Business Rules Discovered

- [RULE] ACK: A Stream callback is acknowledged only after the authoritative sink commits or reports a durable duplicate.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Identity: Message and card actions authorize only by stable DingTalk corp/staff identity; `isAdmin`, nickname, sender ID and card privilege claims are untrusted display/input data.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Secrets: Client Secret remains in the credential provider; session webhook and opaque action token may exist only at their immediate transport boundary and never in logs, fixtures, Agent input or persisted integration outcomes.
  <!-- source: codex/007-dingtalk-stream -->

- [RULE] Identifiers: Business message ID, transport message ID, callback event ID, inbound conversation ID and proactive open-conversation ID are separate namespaces.
<!-- Rules that are NOT obvious from the original requirements but were found during impl.
     Format: - [RULE] <domain>: <statement>
     Example: - [RULE] Flowable: delegateTask() sets DelegationState=PENDING; resolveTask() clears it back to null
-->
  <!-- source: codex/007-dingtalk-stream -->

## Test Findings

- 11 focused files / 37 tests pass, covering recorded text/rich/unsupported/card fixtures, duplicate delivery, delayed ACK, reconnect registration, stable identity, card claim stripping, durable transport dedupe, session expiry/fallback, SSRF/redirect rejection, config fail-closed and exact SDK topic/version contracts.
- Focused strict TypeScript and `git diff --check` pass. Lockfile-only frozen offline validation passes; full workspace installation remains blocked by DNS for unrelated existing Next.js/workerd tarballs.
<!-- What tests revealed, unexpected failures, coverage gaps. -->
  <!-- source: codex/007-dingtalk-stream -->

## Integration Notes

- Ticket 006 should call the exported `DingTalkDeliveryPort` through its transport-neutral outbox dispatcher. The adapter never claims, retries or marks an outbox row itself.
- Ticket 008 should instantiate `RealDingTalkStreamSdk`, `DingTalkStreamAdapter`, `DingTalkCardActionLedger`, the collaboration service sinks and the configured proactive sender. It must refuse enabled startup when credentials are missing.
- Credentialed Stream/group/card smoke remains Ticket 009 HITL. The checked-in smoke is receive-only by default and does not enable external send from a flag alone.
<!-- Things this branch depends on / exposes for other branches.
     Especially: shared entities modified, new DB columns, enum values added.
-->
  <!-- source: codex/007-dingtalk-stream -->

</parallel_dev_learnings>
