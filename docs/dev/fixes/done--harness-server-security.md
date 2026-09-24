---
status: done
created: 2026-09-24
updated: 2026-09-24
approval: user, 2026-09-24. Based on the automated suite (292/292 on Node 24) and Dell's code review; no manual UI walkthrough recorded.
scope: harness server security
owner: assistant
related: [doing--release-distribution-ownership.md, done--reliability-and-polish.md]
---

# Lock the harness server to the local app before release

Pre-release audit (2026-09-24). The harness server drives coding agents that can edit files and run commands, but it listens on every network interface and accepts unauthenticated requests from any origin. This covers network exposure, request authentication, and secret-at-rest handling. It does not cover agent permission-mode design.

---

## 1. Network exposure (release blocker)

- [x] **Bind to loopback by default** — `server/index.ts:1740`. `HOST` defaults to `0.0.0.0`, and Electron (`electron/main.mjs:52`) does not override it, so the packaged app exposes the full API on port 8899 to anyone on the same Wi-Fi/LAN. A peer can post chat turns (agents then edit files or, in full-auto mode, run arbitrary commands), read every conversation from `/api/events`, and overwrite config. Default to `127.0.0.1`. Keep LAN access as an explicit opt-in (`GBS_HOST`, already used by `dev:network`).
  - *Implemented:* `HOST` defaults to `127.0.0.1` (`GBS_HOST` opts in); Vite binds loopback unless `--host` is passed. Commit `12d6122`.
- [x] ~~**Require a per-launch session token on `/api/*`** — `server/index.ts:1018`. Even on loopback, any website open in the user's browser can send "simple" cross-origin requests (for example `POST` with `text/plain`) to `http://127.0.0.1:8899`. `readBody` parses them as JSON regardless of content type, and DNS rebinding also works because nothing checks `Host`. Generate a token in Electron and pass it to the server via env and to the renderer via preload (EventSource: cookie or query param). Reject requests without the token, with a foreign `Origin`, or with a non-loopback `Host`. Dev mode can continue to use the Vite proxy with the token injected.~~
  - *Not implemented:* Replaced by a Host/Origin/Sec-Fetch-Site guard (`server/request-guard.ts`, commit `12d6122`). It blocks LAN peers, cross-site pages, and DNS rebinding. A local process running as the same user can already read `~/.gbs`, so a token would add little. See `docs/dev/plans/implementation--pre-release-hardening.md`.
- [x] **Enforce `application/json` on mutating requests** — `server/index.ts:1000`. Defence in depth against form or `text/plain` CSRF.
  - *Implemented:* `readBody` returns 415 for non-JSON bodies. Commit `12d6122`.
- [x] **Destroy oversized request bodies** — `server/index.ts:1004`. `readBody` rejects after 1 MB but keeps buffering the stream. Call `req.destroy()` and return 413.
  - *Implemented:* 413 and buffering stops. Commit `12d6122`.

## 2. Electron shell hardening

- [x] **Allowlist schemes in `setWindowOpenHandler`** — `electron/main.mjs:153`. Any URL a page or agent-rendered link opens goes straight to `shell.openExternal`, including `file:`, `smb:`, and custom app schemes. Allow only `https:`, `http:`, and `mailto:`.
  - *Implemented:* `openExternalSafely` allows only http/https/mailto. Commit `e3e9d03`.
- [x] **Block top-level navigation away from the app origin** — `electron/main.mjs:153`. Add a `will-navigate` guard on the main window, matching the one already applied to webview guests.
  - *Implemented:* `will-navigate` keeps the window on the app origin and sends other links to the browser. Commit `e3e9d03`.
- [x] **Validate `webContentsId` in `webview:screenshot`** — `electron/main.mjs:200`. Only allow IDs of webview guests attached to our window (track IDs from `did-attach-webview`), not arbitrary webContents.
  - *Implemented:* Only attached preview guests are accepted. Commit `e3e9d03`.
- [x] **Add a Content-Security-Policy** — `index.html`. There is currently no CSP. Restrict `script-src` to `'self'` and `connect-src` to self plus PostHog. This limits the impact if markdown or HTML rendering ever regresses.
  - *Implemented:* Sent as a header on packaged UI HTML (`UI_SECURITY_HEADERS`), since Vite dev needs inline scripts. Verified in Chrome: no violations, and remote logos load. Commit `12d6122`.

## 3. Secrets at rest

- [x] **Write `~/.gbs/config.json` with mode `0600`** — `server/config.ts:85`. API keys (xAI, Composio, Box, Trello) are currently world-readable (`0644`). Also `chmod` existing files on load.
  - *Implemented:* Atomic writes with mode 0600, and an existing file is tightened on load. Commit `863c624`.
- [x] ~~**Consider Electron `safeStorage` (Keychain/DPAPI) for provider keys** — `server/config.ts:59`. This is optional and larger in scope. Consider it after the items above.~~
  - *Not implemented:* Deferred by the plan. Keys are now owner-only (0600). Revisit with a keychain migration plan.
