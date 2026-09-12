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

Account-based providers are aggregated for visibility, but official login/account creation remains in their existing provider-specific settings. The unified surface does not claim to create multiple subscription accounts for every provider.

## Model discovery

Managed API connections use the existing OpenAI-compatible `/models` path. They do not inherit the legacy OpenRouter/Groq seed catalog when no model is configured, preventing unrelated fallback models from appearing after discovery failure. Discovery is opportunistic and preserves the last known catalog on refresh failure.

## Capability boundary

The capability layer currently advertises streaming, reasoning, and model discovery. OpenAI-compatible `toolCalls` remains false until the driver can preserve tool-call request/response data end-to-end. Tool-call responses now fail explicitly rather than silently becoming empty assistant text.

## Redirect and secret safety

Provider requests refuse redirects that change origin or downgrade to HTTP while an Authorization header would be forwarded. Stored API keys are never returned to the renderer.

## Verification requirements

Before considering the branch review-ready:

1. Run `pnpm lint`.
2. Run `pnpm typecheck`.
3. Run the focused provider catalog/capability tests.
4. Run the repository CI matrix on the final branch head.
5. Re-check PR review threads and bot/maintainer comments after CI completes; unresolved correctness/security comments must be fixed before merge.

## Explicit non-goals

- No private OAuth/session-token scraping.
- No quota scraping or quota-evasion failover.
- No arbitrary custom headers that could become hidden credential storage.
- No automatic tool-execution loop in the generic OpenAI-compatible driver yet.
- No claim that every account-based provider supports multiple accounts through the unified UI until each provider has an official add/login delegation path.
