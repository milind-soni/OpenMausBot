# Inkbox Onboarding Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development. User has explicitly directed the in-app setup correction; do not re-ask permission to implement the same requested flow.

**Goal:** Connect iMessage from Mausbot settings with an API key, bot and owner phone, without shell commands or manual webhook configuration.
**Architecture:** A resumable setup coordinator calls fixed provider APIs, persists encrypted credentials via the desktop parent and owns a narrow SDK tunnel. The existing signed receiver stays the execution boundary.
**Tech Stack:** Existing TypeScript/React/Electron plus pinned official @inkbox/sdk for its documented tunnel transport.
**Spec:** docs/superpowers/specs/2026-10-06-inkbox-onboarding-design.md

## Constraints
Original code only. Isolated fixtures only. No real Inkbox calls, purchases, messages, push or PR. Local desktop admin setup; no plaintext secret fallback. Preserve existing delivery receipts across pause/restart. Keep route handlers out of index.ts.

## Review focus
- Partial provider setup and ambiguous writes must not silently create extra resources.
- Disconnect while async work is pending must not reopen ingress.
- Keys must not leak to snapshots, errors, child agents or a substituted URL.
- An already configured identity must not lose its signing key or another app's tunnel.
- Ready transport must not be mistaken for proven phone delivery.

## Tasks
- [x] Coordinator/provider/tunnel: strict schemas, synthetic RED tests, setup stages, redacted state, serialized lifecycle, narrow SDK tunnel and server route/index integration. Root owns shared contract and server modules.
- [x] Secure desktop bridge: private utility-parent read/write, workspace-keyed OS credential storage, strict messages and tests. Agent owns electron integration and server/inkbox-secrets.ts.
- [x] UI: new iMessage settings section, API key/bot/phone form, QR pairing state, errors/reconnect/disconnect and tests. Agent owns frontend components/settings/locales.
- [x] Integration verification: focused regressions, real isolated routes/desktop bridge as appropriate, renderer fixture, independent review, package build and updated local testing guide.
