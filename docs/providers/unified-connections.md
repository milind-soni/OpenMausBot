# Unified provider connections

This branch introduces the first layer of a unified provider/account manager while preserving OpenMausBot's existing provider-specific authentication flows.

## What is included

The provider catalog defines named OpenAI-compatible connection presets for OpenAI, OpenRouter, Groq, Mistral, NVIDIA NIM, and arbitrary OpenAI-compatible endpoints. Each connection can carry its own API key, base URL, optional model, and capability metadata.

NVIDIA NIM is treated as a deployment-specific endpoint rather than assuming a single hosted URL. Current NVIDIA documentation describes NIM's `/v1/models` and OpenAI-compatible `/v1/chat/completions` interfaces, including streaming and tool calling. citeturn798591search0

The Settings-side provider manager aggregates existing account-based engine instances (for example Claude, Codex, Antigravity, Cursor, and OpenCode) instead of replacing their official login flows. No private OAuth/session-token scraping is introduced.

## Secret handling

API keys are intended to remain write-only at the UI boundary. Provider summaries must never include stored secret values. The generic configuration endpoint intentionally does not accept arbitrary `instances` mutations; creation/deletion of named provider instances belongs behind a dedicated, validated server boundary.

## Model discovery

OpenAI-compatible connections use the existing provider driver's model discovery path. The UI should display discovered model identifiers only after a refresh/test operation succeeds; a failed `/models` call must not erase the last known configuration.

## Next implementation slice

The remaining server slice is a dedicated provider-connection endpoint that can safely create, test, and delete named `openai-compat` instances without exposing or round-tripping the existing secret-bearing configuration. Once that endpoint is present, the Settings manager can persist the connections directly while retaining the current `instances`/driver architecture.
