# Implementation plan: pre-release hardening

## Objective

Make the first installer from this fork safe to distribute. The harness API should be reachable only by the app itself, and update and telemetry traffic should go only to accounts we own. Persistence should survive crashes, and desktop behavior should be correct on macOS and Windows. Out of scope: agent permission-mode design, moving secrets to the OS keychain, and obtaining signing certificates.

## Current state

- `server/index.ts:1740` binds `0.0.0.0` with no request authentication. The Vite dev server (`vite.config.ts`) also binds `0.0.0.0` and proxies `/api` with the browser's `Host`/`Origin` headers.
- `electron-builder.yml` publishes updates to `milind-soni/gerer-build-studio-releases`. `src/lib/analytics.ts` ships the upstream author's PostHog token and a first-run email gate that feeds it.
- Store and config files are written in place (`server/store.ts`, `server/config.ts`), and a failed read falls back to empty state.
- `electron/main.mjs` has no single-instance lock, uses a macOS-only log path, calls macOS-only IPC unguarded, and opens any URL scheme externally.

## Proposed changes

1. **Request guard** (`server/request-guard.ts`, new). Every `/api/*` request must carry a loopback `Host`. If `Origin` is present, it must match that host, and `Sec-Fetch-Site` must not be `cross-site`/`same-site`. Requests with a body must be `application/json`. A server deliberately bound to a non-loopback `GBS_HOST` accepts any `Host` but still enforces origin checks. The server defaults to `127.0.0.1`.
   - Oversized bodies return 413 and the socket is destroyed.
   - Rationale for not adding a per-launch token: the realistic attackers are LAN peers (stopped by the loopback bind) and web pages in the user's browser (stopped by the Host/Origin/Sec-Fetch checks, which also defeat DNS rebinding). A local process running as the same user can already read `~/.gbs`, so a token would add little.
2. **Dev proxy** (`vite.config.ts`). Bind loopback unless `--host` is passed (as `dev:network` does). Apply the same guard at the proxy, then rewrite `Host` to the target and drop `Origin`, so LAN dev devices keep working.
3. **Electron** (`electron/main.mjs`, `electron/cua.mjs`).
   - Security: scheme allowlist for external opens, same-origin `will-navigate` guard on the main window, and screenshots only of attached webview guests.
   - Lifecycle: single-instance lock, `app.getPath("logs")`, darwin guards for privacy panes and CUA, and graceful server shutdown on quit.
   - A platform-neutral failure page.
   - A CSP header on UI HTML served by the packaged server.
4. **Distribution**. Publish updates to `myebstudios/GererBuildStudio` releases.
   - Analytics becomes a no-op unless `VITE_POSTHOG_TOKEN` is set at build time, and the email gate is hidden when analytics is off.
   - Drop the `allow-dyld-environment-variables` entitlement.
   - Add a fork copyright line and release notes in `docs/dev/RELEASING.md`.
5. **Persistence**. Atomic temp-then-rename writes. `config.json` is written with mode `0600`. A corrupt file is preserved as `*.corrupt-<ts>`, and the app refuses to overwrite it with empty state.
6. **Composio**. Cap prompt-context lookups at 3 s and cache failures for 45 s. Extract a shared `buildTurnIntegrations`.
7. **Bundle**. Use a Shiki core highlighter with a curated set of languages on the JavaScript regex engine (no WASM). Lazy-load the non-chat screens.

## Verification

- `pnpm typecheck`, `pnpm test`, and new unit tests for the request guard, atomic persistence, and corrupt-config handling.
- Run the built server with `GBS_STATIC_DIR=dist`. Confirm the UI loads with no CSP console errors and that cross-origin and foreign-Host requests get 403.
- `pnpm build` output: confirm grammar chunks are limited to the curated set.

## Risks and rollback

- The guard could reject a legitimate client, such as a tool that calls the API from another origin. Mitigation: explicit error messages and an opt-in `GBS_HOST`. Rollback: revert the guard commit.
- The CSP could block an asset. It applies to packaged static serving only, is verified in a browser, and can be reverted independently.

## Approval

Status: approved by the user on 2026-09-24 ("proceed with implementation").
