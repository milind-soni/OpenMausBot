# Universal Provider & Account Connections Design

## Goal
Make the OpenMausBot fork feel like a unified AI provider manager: users can view supported subscription/CLI accounts through their official login flows, add multiple named OpenAI-compatible API connections, discover models automatically, and assign a provider/account/model to bots without editing engine configuration files.

## Current architecture to preserve

OpenMausBot already has a provider-driver registry and a fleet of engine instances. The built-in registry includes Claude, Codex, Antigravity, Cursor ACP, OpenCode ACP, Custom ACP, OpenAI-compatible, and other drivers. `server/config.ts` persists `instances` and materializes a runtime fleet; the existing engine settings own provider-specific account/auth flows. The generic `openai-compat` driver discovers `/models` and uses the OpenAI Chat Completions contract.

The fork extends these existing boundaries instead of introducing a second orchestration system.

## User-facing design

### Provider manager

Add a single AI Providers surface with two categories:

1. **Account providers** — Claude, Codex, Cursor, Antigravity/Google, OpenCode and other first-class ACP/CLI integrations. These continue to use each provider's official authentication mechanism. Existing provider-specific sign-in/account components remain the authoritative auth implementation; this slice does not invent generic OAuth or session handling.
2. **API providers** — OpenAI, OpenRouter, Groq, Mistral, NVIDIA NIM, and Custom OpenAI-compatible endpoints. These use a reusable connection form with display name, base URL where required, API key, optional model, and automatic model discovery.

Native Anthropic API and Google API protocols are not routed through this generic form because their canonical wire contracts are not OpenAI Chat Completions. Supporting them as first-class API connections requires protocol-specific adapters and tests in a later slice.

### Multiple connections

API providers may have multiple named connections. Each managed API connection receives a stable generated `api-*` id and display name. Existing account providers expose the account instances already supported by their provider-specific integrations.

Account rotation is user-controlled or automatic only when an integration can reliably determine that the selected connection is unavailable; the system must never rotate credentials merely to evade provider rate limits or usage restrictions.

For subscription products, credentials continue to live in the provider's official CLI/ACP configuration or the platform's supported secure credential store. The app must not scrape or expose private session tokens.

### API connection data

An API connection is represented as an OpenMausBot engine instance using the existing `openai-compat` driver. The instance config includes a validated URL, optional selected model, optional OpenRouter provider pin, and a write-only API key stored in the instance environment. Arbitrary custom headers are intentionally outside this slice because they can become an undeclared credential channel and need a separate allowlisted/write-only design.

Connection mutations use the existing atomic configuration boundary. The generic config patch does not accept arbitrary `instances`; `providerConnections` and `providerConnectionDeletes` are validated server-owned operations. API responses and renderer state never return secret values.

### Provider presets

The manager ships presets for:

- OpenAI — `https://api.openai.com/v1`
- OpenRouter — `https://openrouter.ai/api/v1`
- Groq — `https://api.groq.com/openai/v1`
- Mistral — `https://api.mistral.ai/v1`
- NVIDIA NIM — user-supplied endpoint because deployments vary
- Custom — user-supplied OpenAI-compatible endpoint

The generic flow is limited to endpoints that implement the OpenAI-compatible contract. Vendor-specific protocols require dedicated adapters rather than pretending to be compatible.

## Model discovery and capabilities

After saving an API connection, the runtime probes `/models` opportunistically and updates the instance catalog. A failed catalog probe must not destroy a valid saved connection or substitute unrelated seeded models. If a managed connection has no configured model and discovery fails, its catalog remains empty until discovery succeeds or the user supplies a model.

Provider-level capability metadata is deliberately conservative. The shared OpenAI-compatible transport guarantees streaming and model discovery for these presets, so those may be advertised. Reasoning and tool calls remain false by default because protocol compatibility alone does not prove that every model supports them. A capability may be enabled only by an explicit trusted override or future model-specific discovery. This slice does not claim generic vision, structured-output, MCP, or computer-use support.

## Generic OpenAI-compatible agent behavior

The existing `openai-compat` driver remains chat-completions based. The current harness transcript does not carry tool declarations, tool-call parts, or tool results end-to-end, so the generic driver must not advertise tool execution. If a provider returns a non-empty `tool_calls` response, the request fails clearly instead of silently discarding the tool call or converting it to empty assistant text. Empty or absent `tool_calls` values are accepted normally.

## Connection lifecycle and error handling

This slice implements add, remove, list, and model refresh for explicit managed API records. It does not promise a generic edit/toggle lifecycle for every provider connection; such operations require their own server contract, including write-only secret replacement semantics.

- Invalid provider URL or API key input: reject the mutation with an actionable error while leaving the draft in the renderer.
- Unreachable `/models`: keep the connection and preserve the last known catalog; do not delete the connection.
- Duplicate generated id: append a numeric suffix until an unused `api-*` id is found.
- Remove: only explicit managed API connections are eligible. Legacy/manual OpenAI-compatible instances are not presented as removable provider records.
- Assignment-aware reassignment before deletion is not implemented in this slice and therefore is not promised by this manager. A future lifecycle API should add those checks before offering stronger deletion semantics.

## URL, redirect, and secret safety

- Provider URLs require HTTPS except for loopback HTTP (`localhost`, `127.0.0.1`, and IPv6 loopback); credentials, query strings, and fragments are rejected.
- Model discovery does not follow redirects.
- Chat requests reject redirects that change origin or downgrade an HTTPS connection before forwarding Authorization credentials.
- API keys and login tokens are never returned from config/state endpoints, SSE, logs, analytics, or bot context.
- Account login remains with official provider flows.
- Automatic account failover is availability-oriented only and cannot be a quota/rate-limit bypass mechanism.

## Testing

Regression coverage includes provider preset normalization, required base URLs, URL safety, collision-safe ids, conservative capability defaults, managed-instance filtering, provider manager rendering, engine-card regrouping behavior, model discovery behavior, redirect handling, and explicit rejection of unsupported tool-call responses. The final branch must pass the repository GitHub Actions matrix before merge.

## Non-goals for this slice

- Native Anthropic API or Google API protocol adapters.
- Arbitrary custom request headers.
- Private OAuth/session-token scraping.
- Quota scraping or quota-evasion failover.
- Generic tool execution, MCP, computer use, or automatic claims of reasoning/vision/structured-output support.
- A universal edit/enable/disable lifecycle for all provider connection types.
- Replacing provider-specific official account sign-in flows.
