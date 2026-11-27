# OpenCode Go integration plan

- Status: proposed
- Last upstream review: 2026-08-14
- Tracking artifact: the pull request that adds this document

## Summary

Add OpenCode Go as a first-class OpenMausBot engine by running the maintained
OpenCode CLI over its official Agent Client Protocol (ACP) interface and selecting
models from the `opencode-go/*` provider.

The first implementation should reuse OpenMausBot's ACP runtime rather than call
the model endpoints directly. That keeps OpenCode's coding tools, sessions, MCP
support, and permission requests intact. A direct model API driver would only
provide inference; OpenMausBot does not currently have a provider-independent
agent/tool loop to replace the functionality the OpenCode CLI supplies.

This plan uses **OpenCode Go** to mean the current subscription/API product
documented at [opencode.ai/docs/go](https://opencode.ai/docs/go/). It does not
target the archived Go-language repository at `opencode-ai/opencode`, which moved
to a different project and is no longer the current OpenCode implementation.

## Upstream facts to preserve

- OpenCode Go is an optional subscription which exposes a changing set of coding
  models through provider id `opencode-go`.
- The public model catalog is available from
  `https://opencode.ai/zen/go/v1/models`.
- Model inference is split across OpenAI Responses, OpenAI-compatible chat
  completions, and Anthropic Messages endpoints. Treating every model as one
  chat-completions API would be incorrect.
- The maintained OpenCode CLI supports `opencode acp`, a JSON-RPC process over
  stdio. Its ACP implementation includes sessions, streamed messages, tool
  activity, permission requests, cancellation, MCP servers, and model selection.
- In ACP, OpenCode exposes model selection as the `model` session config option.
  The selected value is the full `opencode-go/<model-id>` string and is set with
  `session/set_config_option` before prompting.
- OpenCode accepts an `OPENCODE_API_KEY` environment variable. OpenMausBot should
  inject it only into the OpenCode child process.
- The official cross-platform CLI package is `opencode-ai`; `opencode auth login`
  remains an alternative user-managed credential flow.
- Go's lineup, limits, prices, providers, and retention terms can change. The app
  must link to the live OpenCode documentation rather than duplicate mutable
  commercial details in code.

Primary references:

- [OpenCode Go documentation](https://opencode.ai/docs/go/)
- [OpenCode ACP documentation](https://opencode.ai/docs/acp/)
- [OpenCode CLI documentation](https://opencode.ai/docs/cli/)
- [OpenCode server documentation](https://opencode.ai/docs/server/)
- [Maintained OpenCode repository](https://github.com/anomalyco/opencode)

## Proposed architecture

### Runtime: a small OpenCode ACP shim

Add `server/drivers/acp/opencode-go.ts` as an `AcpSupport` definition over the
existing `createAcpDriver` core:

- driver kind: `opencodeGoAgent`
- display name: `OpenCode Go`
- executable: `opencode`
- argv: `opencode acp`
- model ids: full `opencode-go/<model-id>` values
- credential: `OPENCODE_API_KEY`, scoped to this child
- install commands: `npm install -g opencode-ai@latest` on macOS, Linux, and
  Windows, with the official install/docs page linked as the fallback
- setup link: the OpenCode Go subscription and API-key instructions

Do not fork the OpenCode CLI, vendor its SDK, or start a network-listening server
for the initial integration. ACP already provides a local stdio boundary and fits
the process lifecycle OpenMausBot uses for Grok and Gemini.

### Generic ACP changes

Extend the ACP support object with an opt-in model-selection hook. After
`session/new` or `session/load`, but before `session/prompt`, the core should:

1. inspect the returned `configOptions`;
2. confirm a `model` option exists and contains the requested full model id;
3. call `session/set_config_option` with `{ configId: "model", value: modelId }`;
4. use the returned current value in `session.started`; and
5. fail with an actionable error rather than silently running a different model.

The hook must be opt-in so the existing Grok and Gemini ACP drivers keep their
current CLI-argument model selection until they are deliberately migrated.

OpenCode's ACP authentication method only starts/acknowledges its own login flow;
it does not prove that a Go subscription is active. Availability should therefore
distinguish these states:

- CLI missing: unavailable, show the driver install path from PR #97.
- key missing: unavailable, deep-link to the credential row.
- key present: available enough to attempt a turn.
- invalid key, inactive subscription, quota, or region failure: normalize the
  upstream response without exposing the key; authentication/setup failures
  should carry `setup: true`, while quota and transient provider failures should
  remain normal runtime errors.

### Credentials

Add a write-only OpenCode Go credential alongside the existing app credentials:

```json
{
  "opencodeGo": {
    "key": "..."
  }
}
```

`OPENCODE_API_KEY` remains a supported environment fallback. The config API may
return only `opencodeGo.configured: boolean`; it must never return the key.

Only the OpenCode Go instance receives the resolved key. Other CLI children,
native logs, error text, analytics, and renderer payloads must not receive it.
Clearing or replacing the key should use the existing atomic config write and
provider reload path.

The Connections screen should provide:

- a password input for the API key;
- a link to subscribe/manage OpenCode Go and copy a key;
- a clear notice that this is an optional paid third-party service;
- save, replace, and clear behavior consistent with other credentials; and
- a setup state that can represent both "install the CLI" and "add the key".

The driver may additionally document `opencode auth login` for users who prefer
OpenCode-owned credential storage, but the first implementation should not depend
on reading or editing OpenCode's private auth file.

### Model catalog

Fetch the current catalog from the documented `/zen/go/v1/models` endpoint. Store
the full provider-qualified id in `ModelSelection`, while presenting a clean
label in the picker.

Catalog behavior must be fail-safe:

- use a short timeout and do not block application startup indefinitely;
- validate the response shape and accept only string ids;
- never make a paid inference request during discovery or health checks;
- cache the last good catalog for the process lifetime;
- fall back to a small pinned catalog when offline; and
- refresh on the existing instance re-probe path so upstream additions do not
  require restarting OpenMausBot.

If the current synchronous `ProviderInstance.models` contract prevents honest
refresh, add a small asynchronous catalog method to the driver/registry contract
instead of mutating shared objects behind the registry.

### Sessions, tools, and permissions

Use the existing ACP mapping as the baseline:

- save the OpenCode session id as the resume cursor;
- load that session on the next OpenMausBot turn;
- stream assistant text and reasoning once, without replay duplication;
- translate tool start/completion updates into canonical runtime events;
- translate `session/request_permission` into the existing approval cards;
- deny or cancel when no matching upstream permission option exists;
- forward user allow/deny choices by option id, never by array position;
- send `session/cancel` on interruption and kill the child tree after the grace
  period; and
- surface usage only when OpenCode reports it; do not invent cost values.

The first slice should support the same agent and computer stdio MCP integrations
as the current generic ACP core. HTTP/SSE MCP additions, including a direct
Composio transport, should be a separate follow-up after their ACP schemas and
permission behavior are covered by tests.

## Expected code areas

- `server/drivers/acp/opencode-go.ts`: OpenCode-specific ACP support.
- `server/drivers/acp/core.ts`: opt-in session config/model selection and any
  OpenCode event-shape compatibility found by the protocol spike.
- `server/drivers/builtIn.ts`: registration.
- `server/contracts.ts` and `server/harness/registry.ts`: asynchronous catalog or
  setup metadata only if required by the spike.
- `server/config.ts` and `server/index.ts`: write-only key persistence, environment
  fallback, status reporting, and provider reload.
- `src/components/ApiKeys.tsx`, settings components, and `src/state/store.tsx`:
  credential UI and configured-only state.
- `src/components/ProviderIcons.tsx`, onboarding, and the model picker: provider
  presentation and setup entry points.
- `server/testing/fake-acp-cli.ts` plus ACP/config tests: deterministic protocol,
  credential, catalog, and lifecycle coverage.

Keep unrelated engine setup, styling, and provider refactors out of the
implementation PRs.

## Delivery as small PRs

### PR 1: protocol spike and generic ACP model selection

- Capture one sanitized `opencode acp` session against a test configuration.
- Add fake-ACP coverage for returned session config options.
- Add the opt-in `session/set_config_option` hook.
- Prove requested-model selection, session resume, cancellation, and permission
  behavior without adding a visible engine.

Exit condition: a fake OpenCode ACP process cannot prompt until the requested
`opencode-go/*` model has been acknowledged.

### PR 2: driver, catalog, and credential plumbing

- Add the OpenCode Go driver and built-in registration.
- Add write-only key storage and `OPENCODE_API_KEY` fallback.
- Add model discovery with timeout, validation, cache, and offline fallback.
- Add install/setup metadata and server-side tests.
- Keep the driver opt-in through explicit instance configuration until the live
  smoke test is complete.

Exit condition: `/api/instances` reports the engine honestly for missing CLI,
missing key, ready, and offline-catalog states without leaking the credential.

### PR 3: product setup and picker integration

- Add the Connections credential row and OpenCode Go provider presentation.
- Reuse the PR #97 focus/picker re-probe so install and key changes appear without
  restarting the app.
- Add the engine to onboarding/default fleet only after macOS, Linux, and Windows
  setup paths are verified.
- Link mutable pricing, usage, privacy, and model information to OpenCode's live
  docs.

Exit condition: a new user can go from unavailable to a selectable Go model with
no config-file editing and no false "ready" state.

### PR 4: live smoke coverage and user documentation

- Run an opt-in real-CLI smoke test for one streamed turn, one permission request,
  session continuation, model switch, and cancellation.
- Verify process cleanup and executable discovery on all supported desktop OSes.
- Document setup, key removal, quota/auth errors, and the upstream data-policy
  link.
- Decide whether the engine is ready for the default fleet.

Exit condition: the integration meets the definition of done below and has a
recorded minimum supported OpenCode CLI version.

## Test matrix

Automated tests must cover:

- config decoding and default executable;
- missing executable and refreshed PATH discovery on macOS, Linux, and Windows;
- key absent, environment fallback, saved key, replacement, and clearing;
- configured-only API responses and log/error redaction;
- catalog success, malformed JSON, timeout, HTTP failure, empty result, cache, and
  fallback behavior;
- full provider-qualified model ids and rejection of a model not advertised by
  the ACP session;
- ordering: initialize -> authenticate -> new/load -> set model -> prompt;
- streamed text without duplicate final content;
- tool lifecycle and permission allow, deny, timeout, and missing-option behavior;
- session load, missing-session fallback, and model switching after resume;
- cancellation before and after session creation, early process exit, malformed
  JSON-RPC, and process-tree cleanup; and
- concurrent OpenMausBot threads without shared ACP or credential state.

Live tests must be opt-in because they require a private subscription key and may
consume quota. CI must never print the key or upload native protocol logs from a
credentialed run.

## Definition of done

- OpenCode Go is shown as unavailable until both its CLI and credential are
  present; OpenMausBot never selects it as a runnable default otherwise.
- The setup flow works without restarting OpenMausBot and never silently executes
  an installer.
- A user can select every currently advertised `opencode-go/*` model, and the ACP
  session confirms that exact model before the prompt starts.
- A bot can stream a reply, use coding tools, request approval, continue its
  session, switch models, and cancel cleanly.
- Agent/computer MCP integrations behave like the other ACP engines or are
  explicitly shown as unsupported.
- Missing key, invalid key, inactive subscription, quota exhaustion, region
  restriction, upstream outage, and catalog outage have distinct, useful errors.
- Credentials are write-only and absent from renderer payloads, child arguments,
  logs, analytics, test snapshots, and error messages.
- macOS, Linux, and Windows setup and runtime paths are verified.
- The integration documents a minimum supported OpenCode CLI version and links to
  the live Go pricing, usage, model, and privacy terms.

## Deferred work

- A direct no-CLI OpenCode Go API driver. This requires a generic agent/tool loop,
  tool-call execution, approval brokering, and three upstream wire formats.
- OpenCode's HTTP server/SDK integration. It adds port allocation, authentication,
  readiness, and server lifecycle concerns without an initial advantage over ACP.
- Automatic subscription purchase, billing management, or usage top-ups.
- Persisting or modifying OpenCode's own auth/config files.
- Making Composio available over ACP HTTP/SSE transports.
- Supporting the archived Go-language OpenCode CLI.

## Questions to close in PR 1

1. What minimum OpenCode CLI version has stable `opencode acp` config options and
   permission event shapes for this integration?
2. Does the CLI expose a reliable non-billable credential/subscription readiness
   check, or should readiness mean only "CLI and key present" until the first turn?
3. Does `session/load` return the current `model` config option for all supported
   versions, and can it be switched before every prompt?
4. Which OpenCode Go errors identify invalid credentials, inactive subscription,
   quota, and region restrictions without matching mutable English strings?
5. Should catalog fallback be bundled metadata or the last successful catalog
   persisted on disk?
6. Can the existing ACP usage metadata distinguish cumulative session totals from
   per-turn usage so OpenMausBot does not double-count it?
