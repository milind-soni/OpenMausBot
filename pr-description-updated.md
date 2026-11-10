## What changed

Adds [Mola](https://mola.sh) as a cloud computer provider alongside Boat. It supports both Mola Cloud (https://cloud.mola.sh) and self-hosted [mola-core](https://github.com/obaid/mola-core). The default image is Ubuntu (XFCE desktop).

**Server:**
- `server/mola.ts`: the provider, following the Boat pattern
- `server/mola.test.ts`: 24 unit tests (naming, tokens, commands, viewer origin, timeout clamping)
- `server/included-services.ts`: Mola credential and default API URL (`https://cloud.mola.sh/api/v1`)
- `server/config.ts`: config schema `mola: { token?, apiUrl? }`
- `server/index.ts`: full lifecycle routing (provision, join, sleep, exec, screenshot)

**Electron:**
- `electron/credential-patch.mjs`: molaApiKey handler for secure credential storage
- `electron/workspace-credentials.mjs`: mola.token migration from plaintext config

**Frontend:**
- `src/components/CloudBackendPicker.tsx`: Mola provider selection UI
- `shared/wire.ts`: CloudBackend type includes "mola"

**Documentation:**
- `docs/mola.md`: setup and usage docs

Behavior:
- Mola Cloud uses `/computers`; self-hosted mola-core uses `/machines` with direct desktop links.
- Handles `provisioning`, `booting`, `starting`, `stopping`, `ready`, `stopped`, `error`, plus the `is_transitional` flag.
- Exec timeout is clamped to 1–120 seconds (Mola Cloud's accepted range), and the `timed_out` and `truncated` result fields are surfaced.
- A key lacking `computers:read` and `computers:write` (403 `insufficient_token_ability`) gets a clear error.
- Cloud provisioning succeeds and returns `joinUrl: null`; users open desktops at cloud.mola.sh directly.
- Viewer origin resolves from `MOLA_VIEWER_ORIGIN`, then `customDomain`, then `publicUrl`, and fails clearly if none is set (no localhost fallback).

Current limitation: the Mola Cloud viewer authenticates through an iframe `postMessage` handshake, which isn't implemented yet. Provisioning, command execution, and screenshots work; live desktop viewing requires opening the computer at cloud.mola.sh directly in the meantime.

## Why

This gives OpenMausBot users another Ubuntu desktop backend, either hosted (Mola Cloud) or self-hosted (mola-core), without changing existing providers.

## How it was verified

**Live testing (against Mola Cloud):**
- Real Ubuntu machines: create, status transitions (including `provisioning` / `is_transitional`), exec (timeout range, `timed_out` / `truncated`), viewer grant shape, and 403 error shapes
- Cloud provisioning: machines are created and ready; joinUrl is null as expected

**Unit tests:**
- `server/mola.test.ts`: 24/24 pass
- `src/lib/analytics-allowlist.test.ts`: 7/7 pass (includes mola entries)
- `server/managed-policy.test.ts`: 20/20 pass (includes mola in policy fixtures)

**Static checks:**
- `pnpm typecheck` (`tsc -b && tsc -p tsconfig.server.json`): clean
- Lint (`oxlint --deny-warnings`): clean
- Pre-push hooks (vocabulary ratchet, file size ratchet): clean

**Integration:**
- Mola selectable as bot computer provider in UI
- Bot lifecycle operations (provision, join, sleep, exec, screenshot) route correctly
- Desktop app can save Mola keys securely via OS credential store
- Config migration moves plaintext mola.token to encrypted storage

Tested on Linux only.

## Screenshots (UI changes)

None. This is primarily a server-side provider with minimal UI changes (Mola button added to CloudBackendPicker).

## Checklist

- [x] `pnpm typecheck` passes locally
- [x] Core `pnpm test` passes locally (Mola, analytics allowlist, managed policy tests verified)
- [x] Server behavior changes come with tests (24 Mola unit tests)
- [x] No `dist-server/` edits (it's build output)
- [x] macOS-only code is platform-gated; no `shell: true` / cmd.exe string-building
- [x] No secrets in logs, responses, events, or argv

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

<!-- coderabbit-ai-generated:v1 -->

## Summary by CodeRabbit

- **New Features**
  - Added support for connecting Mola Cloud or self-hosted Mola Core computers, including API key setup, machine management, command execution, and screenshots.
  - Added Mola as a selectable cloud computer provider in bot settings.
  - Added secure credential storage for Mola API keys via OS credential store.
  - Added configuration status and key-management support for Mola credentials.
- **Documentation**
  - Added setup, configuration, usage, limitations, and troubleshooting guidance for Mola integrations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->
