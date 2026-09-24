# Implementation plan: live provider model catalogs

## Objective

Show the models each configured provider actually advertises to this app's credentials or CLI login. Discover additions and removals without an app release, refresh while the app stays open, and make retired selections actionable before a new turn. A provider that offers no machine-readable catalog cannot be represented as an exhaustive list; the UI must say so.

## Current state

- All seven built-in drivers expose fixed `ModelCatalog` data through `ProviderInstance.models` (`server/contracts.ts`, `server/drivers/`). `ProviderRegistry.describe()` copies it into `GET /api/instances` (`server/harness/registry.ts`, `server/index.ts`).
- The UI loads instances at startup and on a few configuration events, then renders the supplied options (`src/state/store.tsx`, `src/components/ModelPicker.tsx`, `src/components/SettingsScreen.tsx`). There is no periodic model refresh or manual refresh action.
- The server forwards the saved model ID to each driver. It does not check whether an ID remains offered when a provider retires it (`server/index.ts`). The computer-backed driver also infers its provider from the model name prefix (`server/drivers/boxagent.ts`), which is fragile when models change.
- Codex has an app-server `model/list` RPC; Antigravity has `agy models`; Grok CLI has `grok models`; the xAI API has `GET /v1/language-models`. Claude Code has no documented CLI model-list command, but its Agent SDK exposes `supportedModels()`. Gemini's ACP session negotiation can advertise model choices; the installed CLI and protocol behavior need verification. No box-service model-list endpoint has been verified.

Provider references: [Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), [Claude Code CLI](https://code.claude.com/docs/en/cli-reference), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript), [Grok CLI](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md), [xAI models API](https://docs.x.ai/developers/rest-api-reference/inference/models), [Gemini ACP mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md).

## Proposed changes

1. Add an asynchronous per-instance catalog discovery method to the provider contract. Return source, refreshed time, default ID, options, and a bounded error/loading state. Make discovery independent of sending a prompt. Normalize labels and IDs, deduplicate, and reject malformed responses. Do not fall back to a stale hard-coded list after a successful provider response, since that would keep retired models visible.
2. Query each provider through its own authenticated surface: Codex `model/list` with pagination; Claude Code's supported-model interface using the user's existing login, with the exact installed CLI/SDK behavior verified before committing to a dependency; Antigravity `agy models`; Grok CLI `grok models` or its ACP metadata if that is more complete; Gemini ACP advertised models; and the xAI language-model endpoint with the configured API key. Keep xAI API and Grok subscription credentials separate. Avoid billable inference calls for discovery.
3. Investigate the box service's published API and, if necessary, a safe read-only query against an isolated box. Use a supported catalog endpoint if available. If no list exists, show a provider-default option plus an explicit "model list unavailable" status. Do not claim to enumerate box models from the local Claude or Codex accounts, because the box may have different access.
4. Cache successful catalogs briefly per instance, coalesce concurrent refreshes, and time out CLI and network queries. Refresh when the picker or Models settings opens, on reconnect and credential changes, and on a server interval while the UI is active. Expose a manual refresh control. A failed refresh may keep the last known list visibly marked stale, but it must not be described as verified current availability.
5. When a saved model disappears from a fresh catalog, retain its historical ID and label for existing transcripts, mark it unavailable in the picker, and prompt for a replacement before the next turn. Do not silently switch models or overwrite conversation history. Select a provider-advertised default for newly created bots.
6. Update the picker and Settings to show discovery state, model source and refresh time, provider errors, and a retired-model state. Update project documentation to explain refresh behavior and limitations. Keep the current settings and bot persistence formats compatible.

## Verification

- Driver tests with fake CLIs, fake ACP exchanges, and local HTTP endpoints for each discoverable provider. Cover additions, removals, defaults, malformed output, missing login, timeouts, pagination, and credentials never appearing in API responses or logs.
- Registry/API tests for cache coalescing, refresh, unavailable providers, and retired selections; no test reads or writes the real `~/.gbs`.
- UI state tests for model additions, retirement, stale/error indications, and a manual refresh, plus a desktop click-through with the installed Codex, Claude, and Antigravity CLIs where available.
- Run `pnpm typecheck`, relevant tests, full `pnpm test`, and `pnpm build`. Review a packaged desktop build because `dist-server/` is generated.

## Risks and rollback

- Provider discovery contracts and subscription entitlements can change. Keep parsing provider-specific and fail with a visible status; never invent availability from public marketing lists or API-key catalogs for subscription users.
- Model discovery can be slow or require authentication. Bound requests and cache successful results so opening the picker does not stall the app.
- Claude SDK discovery may require a new dependency or may not match the installed CLI's account. Verify that it uses the same login and returns the same selectable IDs before adopting it.
- A box catalog may not be exposed at all. The default-only behavior above is the honest fallback until the box service provides a model-list endpoint.
- Rollback is a scoped revert of the contract, drivers, registry, and UI changes; saved bot model IDs remain intact.

## Approval

Status: awaiting user approval
