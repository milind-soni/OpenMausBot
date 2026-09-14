# Unified provider connections

This branch introduces the first layer of a unified provider/account manager while preserving OpenMausBot's existing provider-specific authentication flows.

## What is included

The provider catalog defines named OpenAI-compatible connection presets for OpenAI, OpenRouter, Groq, Mistral, NVIDIA NIM, and arbitrary OpenAI-compatible endpoints. Each connection can carry its own API key, base URL, optional model, and conservative capability metadata.

NVIDIA NIM is treated as a deployment-specific endpoint rather than assuming a single hosted URL. Current NVIDIA documentation describes NIM's `/v1/models` and OpenAI-compatible `/v1/chat/completions` interfaces. The generic driver does not advertise tool-call support until it can preserve and execute that wire contract safely.

The Settings-side provider manager aggregates existing account-based engine instances (for example Claude, Codex, Antigravity, Cursor, and OpenCode) instead of replacing their official login flows. No private OAuth/session-token scraping is introduced.

## Secret handling

API keys are write-only at the UI boundary. Provider summaries and instance snapshots never include stored API-key values. Creation and deletion use the validated `providerConnections` and `providerConnectionDeletes` mutations carried by the existing config persistence path; the generic config patch still does not accept arbitrary `instances` edits.

Managed API connections use generated `api-*` ids. Legacy or manually configured `openai-compat` instances remain outside the manager's remove path.

Provider API URLs must use HTTPS; HTTP is allowed only for loopback development endpoints. Credentials, query strings, and fragments are rejected from provider URLs. Redirected provider requests are not allowed to change origin or downgrade to HTTP while carrying an Authorization header.

## Model discovery

OpenAI-compatible connections use the existing driver's `/models` discovery path. Managed API connections start without the legacy OpenRouter/Groq seed catalog when no model is explicitly configured, so an unavailable discovery endpoint cannot accidentally expose an unrelated model as the default. A failed discovery call preserves the last known catalog/configuration.

## Account providers

Account-based providers keep their existing official login/account mechanisms. The unified manager is an aggregation surface; it does not scrape provider sessions or create unofficial OAuth flows.

## Current mutation contract

The provider manager sends a connection record containing a display name, API key, validated base URL, and optional model. The server stores the secret only in the per-instance environment and creates an `openai-compat` instance. Deletion is limited to the generated `api-*` provider records and never accepts arbitrary engine ids.
