---
status: done
created: 2026-09-24
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: live provider model catalogs
owner: codex
related: [done--model-switch-history.md]
---

# Discover and refresh available provider models

Replace fixed model-picker catalogs with account-aware provider discovery, refresh them automatically, and handle models that disappear without silently routing a bot to an unsupported model. The implementation details and provider limitations are recorded in `docs/dev/plans/implementation--live-provider-model-catalogs.md`.

---

## 1. Discovery and refresh

- [x] **Define a live catalog contract and refresh lifecycle** — `server/contracts.ts:167`, `server/harness/registry.ts:94`, `server/index.ts:1528`. Return per-instance models from discovery with bounded caching, refresh and error states, and no secret exposure.
- [x] **Discover Codex and Claude Code models from their authenticated agent surfaces** — `server/drivers/codex.ts:31`, `server/drivers/claude.ts:40`. Use the installed agent's account and preserve its model IDs.
- [x] **Discover Grok, Antigravity, Gemini, and xAI API models from their own surfaces** — `server/drivers/acp/grok.ts:15`, `server/drivers/antigravity.ts:40`, `server/drivers/acp/gemini.ts:32`, `server/drivers/grok.ts:21`. Keep subscription and API-key catalogs separate.
- [x] **Resolve the computer-backed model source** — `server/drivers/boxagent.ts:28`. Use a verified box-service catalog if one exists; otherwise expose the provider-selected default and a clear limitation instead of a stale list.

## 2. Selection and verification

- [x] **Refresh the picker and handle retired selections** — `src/components/ModelPicker.tsx:91`, `src/state/store.tsx:974`, `server/index.ts:1376`. Surface catalog loading and failure, preserve historical model labels, and require a valid selection before sending a new turn.
- [x] **Cover discovery, refresh, and retirement with isolated tests** — `server/drivers/codex.test.ts:22`, `server/drivers/claude.test.ts:25`, `server/harness/registry.test.ts:40`. Use fake CLIs and endpoints, and keep tests out of the user's real data directory.
