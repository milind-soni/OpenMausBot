---
status: todo
created: 2026-09-24
updated: 2026-09-24
scope: release signing and telemetry
owner: unassigned
related: [doing--release-distribution-ownership.md]
---

# Sign distributable installers and gate telemetry behind consent

Split out of the pre-release audit. These items need accounts or certificates the user must obtain, or they only matter once analytics is turned back on. See `docs/dev/RELEASING.md`.

---

## 1. Signing

- [ ] **Obtain a Developer ID Application certificate** — `electron-builder.yml:47`. The keychain has only `Apple Development`, which Gatekeeper rejects on other Macs (`spctl` → rejected) and which Squirrel.Mac auto-update will not accept.
- [ ] **Enable notarization** — `electron-builder.yml:58`. Once the certificate exists, set `notarize: true` and provide `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`.
- [ ] **Decide on Windows code signing** — `electron-builder.yml:70`. Without it, SmartScreen warns on every download.

## 2. Telemetry (before re-enabling analytics)

- [ ] **Add a Settings toggle for usage analytics** — `src/lib/analytics.ts:17`. Respect it before `posthog.init` and on change.
