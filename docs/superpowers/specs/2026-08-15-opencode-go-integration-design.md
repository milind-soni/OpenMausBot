# OpenCode Go Integration Design

## Goal

Add OpenCode Go as an optional first-class OpenMausBot engine by launching the maintained OpenCode CLI through its ACP stdio interface. The integration must preserve the existing session, streaming, tool, permission, cancellation, MCP, credential, and model-selection contracts.

## Scope

- Add an ACP support definition and OpenCode Go driver using the existing ACP runtime.
- Detect the `opencode` executable through the repository's existing cross-platform PATH discovery.
- Expose advertised `opencode-go/*` models from the public catalog, with safe fallback behavior when the catalog is unavailable.
- Store the API key write-only and inject it only into the OpenCode child process as `OPENCODE_API_KEY`.
- Integrate availability, setup, onboarding, and model selection without making OpenCode Go a default engine.
- Cover protocol ordering, streaming, tools, permissions, resume, model switching, cancellation, process cleanup, catalog failures, and credential redaction with automated tests.
- Keep live subscription tests opt-in and prevent credentials or native protocol logs from appearing in CI output.

## Out of scope

- A direct OpenCode Go HTTP/API driver.
- OpenCode's HTTP server/SDK lifecycle.
- Automatic installation, subscription purchase, billing, usage top-ups, or modification of OpenCode's own auth files.
- Support for the archived Go-language OpenCode repository.

## Architecture

`server/drivers/acp/opencode-go.ts` will define the engine-specific executable, environment construction, model catalog metadata, and ACP session behavior on top of `server/drivers/acp/core.ts`. It will use the same registry and contracts as the existing ACP engines, so the engine remains isolated from provider-specific model APIs.

The catalog layer will fetch `https://opencode.ai/zen/go/v1/models`, normalize only valid provider-qualified model IDs, cache the last successful result in memory, and fall back to a small static availability response when the endpoint is unavailable. The UI will consume the existing engine/model payloads and will not receive the credential.

Credential handling will follow existing write-only secret conventions. The key may come from configured storage or an environment fallback, but renderer payloads, logs, errors, snapshots, child arguments, and analytics must never contain it. Only the spawned OpenCode process receives `OPENCODE_API_KEY`.

## Runtime flow

1. Registry discovers the OpenCode executable and checks configuration/credential presence.
2. Setup or onboarding can configure the engine without installing a CLI or restarting the app.
3. A session starts through ACP, authenticates, creates or loads a session, and sets the full `opencode-go/<model-id>` value with `session/set_config_option` before the first prompt.
4. ACP events stream text and tool activity through existing OpenMausBot event handling.
5. Permission requests are brokered through the existing permission proxy; allow, deny, timeout, and missing-option paths remain explicit.
6. Cancellation terminates the session/process cleanly, including early exit and malformed JSON-RPC cases.

## Error handling

Errors must distinguish missing CLI, missing/invalid credential, inactive subscription, quota/region restrictions, upstream outage, and model-catalog outage. Mutable upstream English messages must not be used as the sole classifier. Catalog failure must not make unrelated engines unavailable, and OpenCode Go must never be selected as runnable unless its executable and credential prerequisites are satisfied.

## Testing and acceptance

Unit tests will use the existing fake ACP CLI/test harness where possible. They must verify config defaults, refreshed PATH discovery, write-only credentials, catalog success/failure/cache/fallback, exact model IDs, protocol ordering, streaming without duplicate final content, tool/permission lifecycle, resume and model switching, cancellation/process cleanup, and concurrent sessions without shared state. A live test suite is opt-in only.

The implementation is complete when all advertised models can be selected and confirmed by ACP, sessions can stream/tool/continue/switch/cancel, setup works on macOS/Linux/Windows paths, secrets remain absent from all observable app surfaces, and the normal repository typecheck/build/test commands pass.
