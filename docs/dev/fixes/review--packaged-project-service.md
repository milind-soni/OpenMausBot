---
status: review
created: 2026-09-24
updated: 2026-09-24
scope: packaged project service
owner: assistant
related: [done--projects-screen.md]
---

# Make the packaged project service available at app startup

The installed macOS app fails before opening because the Electron main process imports `projects.mjs` from `app.asar`, while packaging places that module in `Resources/electron`. Correct the packaged import and verify a fresh installer launches.

---

## 1. Packaging and verification

- [?] **Resolve the packaged project service from its resource location** — `electron/main.mjs:8`. Development loads the local module; the packaged main process loads `Resources/electron/projects.mjs`, matching the server's resource path.
- [?] **Verify the packaged module and launch** — `electron-builder.yml:38`. `pnpm package` and code signature verification passed; the rebuilt and installed apps launched, reported healthy harness servers, and served the UI with HTTP 200.
