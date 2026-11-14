# Dynamic Island Omi Context Adapter Verification

This record covers the review and verification of `electron/island-omi.mjs` and its unit suite `electron/island-omi.node-test.mjs` against the official `BasedHardware/omi` clone (`backend/routers/developer.py`, `backend/utils/other/list_budget.py`, `backend/utils/external_read_contract.py`, `backend/utils/api_key_families.py`, `docs/doc/developer/api/overview.mdx`, `memories.mdx`, and `conversations.mdx`).

## Contract and Behavior Verified

- **Read-only coexistence**: `createOmiContext` only issues HTTP `GET` requests to `https://api.omi.me/v1/dev/user/` (`memories?limit=20` and `conversations?limit=10&include_transcript=false`) with `redirect: "error"` and `Authorization: Bearer omi_dev_...` (verified against `overview.mdx` and `backend/utils/api_key_families.py`, where `omi_dev_` is required for `/v1/dev/user/...` and `omi_mcp_` keys are rejected with `401`). It does not touch the microphone, audio capture, or local Omi app data.
- **Public API contract**: Preserves `createOmiContext({ fetch, readKey, writeKey, onChange, now, setTimer, clearTimer })` returning `{ configure, disconnect, refresh, snapshot, context, dispose }`.
- **Schemas and truncation**:
  - `GET /v1/dev/user/memories` (`backend/routers/developer.py`, `get_memories`) returns `List[DeveloperMemory]` with `content`, `created_at`, and `updated_at`, sliced to at most 20 items; `403` on `memories` (server-side readiness gate `developer_memory_access_not_ready`) preserves fulfilled `conversations` results while reporting an error status.
  - `GET /v1/dev/user/conversations` (`backend/routers/developer.py`, `get_conversations`) returns `List[Conversation]` with `created_at` and `structured.{title, overview}`.
  - `X-Omi-List-Truncated: true` (`backend/utils/other/list_budget.py`, `OMI_LIST_TRUNCATED_HEADER`) surfaces `"Contexto parcial do Omi atualizado."`.
  - Formatted context is prefixed with an external-data warning and capped at 8,000 characters; per-field text is capped at 1,500 characters (`4096` input char scan limit), and whitespace-only/control-only entries are skipped.
- **Control-character sanitization without lint suppression**: `text()` strips ASCII control characters `< 0x20` (other than `\t`, `\n`, `\r`) and `0x7f` (`DEL`) by code point iteration, eliminating `eslint(no-control-regex)` without suppressing the rule.
- **Timeouts, polling, and `Retry-After`**:
  - Each `refresh()` arms a 15,000 ms `AbortController` deadline timer (`abortController` scoped per attempt so stale timers cannot abort or clear a newer attempt).
  - Polling runs every 120,000 ms while configured, staying well within Omi's documented hourly read budgets (`overview.mdx`: 120/h memories, 60/h conversations).
  - Non-OK responses cancel unconsumed bodies (`response.body?.cancel()`). `429` responses and any non-OK response carrying `Retry-After` (such as `503`) trim and parse numeric-second or HTTP-date `Retry-After` headers, enforce at least 120,000 ms, ignore blank values, and clamp the upper bound to `2_147_483_647` ms to avoid 32-bit `setTimeout` overflow.
- **Concurrency and key protection**:
  - Concurrent `refresh()` calls coalesce onto the active promise.
  - `configure()` and `disconnect()` serialize `writeKey` persistence via `storage`, bump `generation`, abort any in-flight `prior` fetch, coalesce with any `refresh()` started while persistence is pending, and discard late responses from superseded generations.
  - Key material is accessed only through `readKey`/`writeKey` callbacks, never stored in `snapshot()` or `context()`, and provider response bodies on error are redacted.

## Commands and Results

Lint check (`npx oxlint --deny-warnings electron/island-omi.mjs electron/island-omi.node-test.mjs`):

```text
Found 0 warnings and 0 errors.
Finished in 79ms on 2 files with 96 rules using 10 threads.
```

Unit tests (`node --test electron/island-omi.node-test.mjs`):

```text
✔ fetches bounded context from official endpoints and never exposes the key (43.3415ms)
✔ coalesces refreshes and ignores late results after disconnect (9.896042ms)
✔ respects Retry-After even when refresh is manually requested (0.929167ms)
✔ keeps available conversations when memory access is denied and redacts provider errors (0.653083ms)
✔ configuration validates key kind and persists before requesting data (0.880791ms)
✔ dispose prevents deferred reads from fetching or repopulating context (1.017333ms)
✔ strips control characters including DEL, skips blank items, and flags X-Omi-List-Truncated (0.899667ms)
✔ aborts in-flight fetch after 15s deadline and schedules 120s retry (3.251625ms)
✔ disconnect wins race against pending configure persistence (1.335625ms)
✔ clamps oversized Retry-After, ignores blank Retry-After, and honors 503 Retry-After (1.468208ms)
✔ configure aborts prior refresh and coalesces a refresh triggered while persisting (1.707792ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 294.449875
```

## Limitations

- All `node --test` assertions run against synthetic `fetch`, `readKey`/`writeKey`, and timer fixtures; no live `https://api.omi.me` network calls or real `omi_dev_` credentials were used.
- `island-omi.mjs` only fetches the first page (`memories?limit=20`, `conversations?limit=10&include_transcript=false`) and does not follow `X-Omi-Next-Cursor` (`backend/utils/external_read_contract.py`), by design to keep context bounded to 8,000 characters.
- `validKey` accepts any `omi_dev_[A-Za-z0-9_-]{1,2048}` token (`island-key-store.mjs` uses the same rule) for forward compatibility with synthetic/future keys, whereas Omi's current production backend (`backend/utils/api_key_families.py`) specifically generates `omi_dev_` followed by 32 hex chars (`[0-9a-f]{32}`).
- Electron UI/keychain/IPC integration (`electron/island-main.mjs`, `electron/island-key-store.mjs`, `electron/island-session.mjs`) is outside the scope of this unit suite; the Electron smoke test (8 flows) was reported separately.
