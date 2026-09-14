# Universal Provider & Account Connections Plan

## Goal
Provide one Settings surface for named API connections and existing account-based engine logins, without scraping sessions or weakening the existing config/security boundary.

## Implemented architecture

API connections remain normal `openai-compat` instances persisted through the existing atomic config path. Managed connections receive generated `api-*` ids and store API keys only in the instance environment. Existing provider-specific login/account flows remain unchanged.

The generic `/api/config` patch still does **not** accept arbitrary `instances`. Provider-specific mutations are validated separately as `providerConnections` and `providerConnectionDeletes` and only create/delete OpenAI-compatible managed connections.

## Current provider scope

Supported API presets:

- OpenAI
- OpenRouter
- Groq
- Mistral
- NVIDIA NIM
- Custom OpenAI-compatible endpoints

NVIDIA NIM and custom connections require an explicit base URL. Provider URLs must use HTTPS, except loopback HTTP for local development. Credentials, queries, and fragments are rejected.

Native Anthropic API and Google API protocols are outside this generic OpenAI-compatible slice and require protocol-specific adapters before they can be offered as first-class API presets.

Account-based providers are aggregated for visibility, but official login/account creation remains in their existing provider-specific settings. The unified surface does not claim to create multiple subscription accounts for every provider.

## Model discovery

Managed API connections use the existing OpenAI-compatible `/models` path. They do not inherit the legacy OpenRouter/Groq seed catalog when no model is configured, preventing unrelated fallback models from appearing after discovery failure. Discovery is opportunistic and preserves the last known catalog on refresh failure.

## Capability boundary

Capability metadata advertises only transport-level guarantees. Streaming and model discovery are true for the current OpenAI-compatible presets. Reasoning and tool calls remain false by default unless a trusted model-specific capability source or a future end-to-end runtime implementation proves support. Tool-call responses fail explicitly rather than silently becoming empty assistant text.

## Redirect and secret safety

Provider requests refuse redirects that change origin or downgrade to HTTP while an Authorization header would be forwarded. Model discovery does not follow redirects. Stored API keys are never returned to the renderer.

Arbitrary custom request headers are intentionally excluded because they can become hidden credential storage and need a separate allowlisted/write-only design.

## Lifecycle boundary

This slice supports list, add, remove, and model refresh for explicit managed `api-*` provider records. It does not promise generic edit/enable/disable semantics or assignment-aware reassignment on deletion. Those behaviors require dedicated server contracts before they are exposed in the UI.

## Verification requirements

Before considering the branch review-ready:

1. Run lint and typecheck in the repository CI workflow.
2. Run the focused provider catalog/capability and engine-library regression tests.
3. Run the repository GitHub Actions matrix on the final branch head.
4. Re-check PR review threads and bot/maintainer comments after CI completes; unresolved correctness/security comments must be fixed before merge.

## Explicit non-goals

- No native Anthropic/Google protocol support through the generic OpenAI-compatible driver.
- No private OAuth/session-token scraping.
- No quota scraping or quota-evasion failover.
- No arbitrary custom headers that could become hidden credential storage.
- No automatic tool-execution loop in the generic OpenAI-compatible driver yet.
- No generic claim that every compatible endpoint/model supports reasoning, vision, structured output, MCP, or computer use.
- No claim that every account-based provider supports multiple accounts through the unified UI until each provider has an official add/login delegation path.
