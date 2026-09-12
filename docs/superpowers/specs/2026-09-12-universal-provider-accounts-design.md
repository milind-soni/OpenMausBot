# Universal Provider & Account Connections Design

## Goal
Make the OpenMausBot fork feel like a unified AI provider manager: users can connect supported subscription/CLI accounts through their official login flows, add multiple accounts, add API-backed providers through one reusable OpenAI-compatible connection flow, discover models automatically, and assign a provider/account/model to bots without editing engine configuration files.

## Current architecture to preserve

OpenMausBot already has a provider-driver registry and a fleet of engine instances. The built-in registry includes Claude, Codex, Antigravity, Cursor ACP, OpenCode ACP, Custom ACP, OpenAI-compatible, and other drivers. `server/config.ts` persists `instances` and materializes a runtime fleet; `src/components/EnginesSettings.tsx` manages existing engine instances and account cards. The generic `openai-compat` driver already discovers `/models` and uses the OpenAI Chat Completions contract.

The fork will extend these existing boundaries instead of introducing a second orchestration system.

## User-facing design

### Provider manager

Add a single Connections/AI Providers surface with two categories:

1. **Account providers** — Claude, Codex, Cursor, Antigravity/Google, OpenCode and other first-class ACP/CLI integrations. These use the provider's official authentication mechanism. Existing provider-specific sign-in/account components remain the authoritative auth implementation.
2. **API providers** — OpenAI, Anthropic API, Google API, Mistral, Groq, NVIDIA NIM, OpenRouter, and Custom OpenAI-compatible. These use a reusable connection form with provider name, base URL, API key, optional provider routing/header settings, and automatic model discovery.

### Multiple accounts

A provider may have multiple named connections. Each connection has a stable local id and display name. Bots select a specific connection. Account rotation is user-controlled or automatic only when an integration can reliably determine that the selected connection is unavailable; the system must never rotate credentials merely to evade provider rate limits or usage restrictions.

For subscription products, credentials continue to live in the provider's official CLI/ACP configuration or the platform's supported secure credential store. The app must not scrape or expose private session tokens.

### API connection data

An API connection is represented as an OpenMausBot engine instance using the existing `openai-compat` driver. The instance config includes a URL, selected model, optional OpenRouter-style provider pin, and a secret key. The connection manager owns friendly metadata and presets; the runtime continues to use the driver registry and existing instance lifecycle.

Connection records are persisted under the existing 0600 configuration boundary. API responses and SSE events never return secret values. The existing write-only key conventions are retained.

### Provider presets

The manager ships presets for:

- OpenAI — `https://api.openai.com/v1`
- OpenRouter — `https://openrouter.ai/api/v1`
- Groq — `https://api.groq.com/openai/v1`
- Mistral — `https://api.mistral.ai/v1`
- NVIDIA NIM — user-supplied endpoint because deployments vary
- Custom — user-supplied OpenAI-compatible endpoint

The design must not require a dedicated driver per vendor when the vendor implements the OpenAI-compatible contract.

## Model discovery and capabilities

After saving an API connection, the runtime probes `/models` opportunistically and updates the instance catalog. A failed catalog probe must not destroy a valid saved connection; the configured model remains selectable.

Introduce a capability description on the provider/model presentation layer. At minimum expose whether a model/driver supports streaming, reasoning, tool calls, vision, structured output, MCP-capable tools, and computer-use integration. Unknown capabilities are shown as unknown rather than falsely supported. Existing drivers may report their known capabilities; generic OpenAI-compatible models default to chat/streaming/reasoning support and derive tool support from the actual request/response path where available.

## Generic OpenAI-compatible agent behavior

The existing `openai-compat` driver remains chat-completions based, but the runtime adapter must preserve tool-call/message parts when the upstream endpoint supports them. This is additive: text-only providers continue to work. Unsupported tool calls fail clearly and safely rather than silently becoming plain text.

## Error handling

- Invalid URL/API key: show an actionable connection error; keep the draft form populated.
- Unreachable `/models`: save the connection and mark model discovery as unavailable; do not delete the connection.
- Provider rejects the key: show rejected/unauthorized status without exposing the key.
- Duplicate connection id/name: generate a deterministic id from a normalized slug and append a numeric suffix.
- Removing a connection that is assigned to bots: prevent deletion until reassigned, or offer a reassignment flow. Do not silently retarget bots.
- Changing credentials for a running connection: persist first, then reload only the affected provider instance/fleet; do not interrupt unrelated in-flight turns.

## Security constraints

- Never return API keys or login tokens from GET config/state endpoints, SSE, logs, analytics, or bot context.
- Never inherit every workspace credential into every child process. Only the driver that consumes a credential receives it.
- Account login remains with official provider flows.
- Automatic account failover is availability-oriented only and cannot be a quota/rate-limit bypass mechanism.
- Delete operations must be scoped to the user's fork and explicit provider records; do not add destructive migration behavior.

## Testing

Add unit tests for provider preset normalization, connection validation, duplicate-id generation, secret-redaction/status projection, and model discovery failure handling. Add component tests for add/edit/test/delete flows and for multiple connections per provider. Add driver tests covering an OpenAI-compatible endpoint returning models, a text stream, and a tool call response. Run the existing typecheck/unit test suite after each logical implementation slice.

## Non-goals for this slice

This first implementation does not replace provider-specific sign-in protocols, scrape consumer session cookies, or implement vendor-specific API semantics that are not OpenAI-compatible. It also does not invent a generic quota scraper; account status is limited to what official integrations expose.
