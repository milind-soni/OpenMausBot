# Provider prompt inspector

Use an isolated workspace, never the installed app or personal chat data.

```sh
pnpm exec vitest run server/prompt-inspector.test.ts server/prompt-inspector.e2e.test.ts src/lib/prompt-inspector.test.ts server/request-auth.test.ts server/harness/registry.test.ts server/drivers/openai-chat.test.ts
pnpm exec vitest run scripts/testing/prompt-inspector-ui.e2e.test.ts
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.server.json
```

The server fixture launches the real server with the repository's fake engine.
It verifies private/group capture, thread identity and deletion cleanup. The
HTTP test drives the real OpenAI-compatible adapter against a loopback SSE
endpoint and compares its received request body with the persisted capture.
It checks cache usage, redaction and diagnostic headers. Additional cases cover
parallel turns, stale events, unavailable storage and interrupted requests.
The authentication regression denies client-scoped sessions access to captures.

The UI fixture uses the real renderer and isolated server. It checks captured
text, comparison, refresh, search, close/Escape and keyboard focus return. The
pinned browser must already be installed, or set `OMB_UI_E2E=1` to install it.
The English screenshot is saved under `.omb-scratch/verify-evidence/`.

## Capture boundaries

Every provider instance supplies an **agent input** record: the values passed
to its adapter, with whole-turn usage when supplied by the completion event.
This is not the final model HTTP payload of an external CLI or ACP process.

The shared direct chat-completions runtime also captures **API request** bodies
and per-request usage/allowlisted response headers. This covers OpenAI-compatible,
Grok and MiniMax connections using that runtime. Provider-internal instructions,
transport headers, internal tokenization and native CLI final HTTP payloads
are not reconstructed or invented. No routing, caching or provider configuration
is changed to obtain captures.

Six records per thread are retained; bodies above 4 MiB are omitted, deeply
nested content is bounded, and previews/diffs are limited. Credentials are
redacted before persistence, but ordinary conversation content remains private:
review an export before sharing it. Deletion invalidates pending captures and
purges stored cross-thread copies referencing the deleted conversation.

These checks prove local integration, not paid-provider availability, model
quality or cache-hit guarantees. Unknown caching is displayed as unknown,
not zero. Agent-turn totals and individual API-call usage must not be summed.
