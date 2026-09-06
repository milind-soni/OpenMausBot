# One browser engine: agent-browser

**Decision (Sep 6, 2026):** the bots' browser is [agent-browser](https://github.com/vercel-labs/agent-browser)
(Vercel Labs, Apache-2.0), pinned, on every platform: macOS, Windows and Linux
desktop, and headless servers. It replaces the Electron browser surface. The
comparison behind the decision (Playwright MCP, Chrome DevTools MCP, Steel,
Stagehand, browser-use, browserless, Lightpanda) is summarised at the end.

## Why

- **Windows has no browser today.** The Electron surface needs the renderer
  sandbox, and Electron 43 exits before ready with it on Windows
  (electron/electron#51761). A browser that is its own Chrome process, driven
  over CDP, does not depend on that.
- **Servers have no browser today.** `openmausbot serve` and the Docker stack
  run without Electron, so `availableBrowserConnection()` is null and the
  toggle is greyed.
- **One engine, one contract.** A skill written on a Mac runs on a VPS.
- **The login wall.** Every shipping agent product (ChatGPT agent, Browserbase
  Live View, Cloudflare Browser Run) hands the browser to the human at a
  sign-in or CAPTCHA and resumes. agent-browser's stream carries screencast
  frames out and mouse/keyboard in, so we get watch-and-take-over on desktop
  and server for the price of a canvas.

## What agent-browser gives us

- A Rust daemon over CDP; Chrome for Testing downloaded and verified by
  `agent-browser install` (existing Chrome/Chromium/Brave detected).
- Isolated, parallel **sessions** (`--session <id>`), with `--restore`
  auto-saving cookies and localStorage under a stable key; persistent
  profiles; reuse of the user's own Chrome profile on a desktop; auth state
  import/export; an encrypted auth vault (`AGENT_BROWSER_ENCRYPTION_KEY`).
- An MCP stdio server (`agent-browser mcp --tools core`) whose verbs match our
  17 `browser_*` tools almost one to one.
- A stream server: JPEG frames (latest-wins, configurable quality/fps), the
  active URL, viewport metadata; `input_mouse` / keyboard messages back in
  with per-client input priority.

## Shape

```
bot turn ──MCP stdio──> agent-browser mcp (session = bot or shared profile) ──CDP──> Chrome
web UI browser panel <──ws frames / input──> agent-browser stream server ────────────┘
```

Where it plugs in today: `browserIntegration()` in `server/index.ts` returns
the MCP server spec mounted into a turn (`{command, args, env}`), guarded by
the workspace flag (`features.browser`), the bot's own switch, and the
engine's `capabilities.browserMcp`. With no desktop connection it returns
null; the headless engine becomes the second source of a spec there.

## Steps

### 1. Headless engine (servers, and the fallback everywhere)

- `server/browser-engine.ts`: resolve the pinned agent-browser binary
  (`OMB_AGENT_BROWSER_PATH` → `$OMB_DATA_DIR/tools/agent-browser/<version>/` →
  PATH); download from the GitHub release with per-platform SHA-256 pinned in
  `server/browser-engine-release.ts` (same pattern as `antigravity-release.ts`
  and `prepare-cloudflared.mjs`); ensure Chrome with `agent-browser install`;
  report `unavailable` with the reason rather than degrading silently.
- `browserIntegration()`: when no desktop connection exists and the engine is
  available, return `{command: <binary>, args: ["mcp", "--tools", "core",
  "--no-webmcp"], env: {AGENT_BROWSER_SESSION, AGENT_BROWSER_RESTORE: "1",
  AGENT_BROWSER_ENCRYPTION_KEY, AGENT_BROWSER_HEADLESS: "1"}}`. Session id =
  the bot's browser profile partition, or the bot id (own session).
- Encryption key: generated once into `$OMB_DATA_DIR/browser-engine-key`
  (0600), like the tunnel credentials.
- Capability: the environment descriptor gains `capabilities.browser:
  "desktop" | "headless" | "unavailable"` (+ reason), and the Settings toggle
  and the per-bot switch key off it instead of `window.ogb.browser`.
- Docker: `npm install -g agent-browser@<pinned>` and `agent-browser install
  --with-deps` at build time, as root, before `USER maus`.
- Tests: resolver and download pinning (stub server), the integration spec
  (mutation-check the guards), an e2e turn against a fake `agent-browser`
  binary that speaks MCP.

### 2. Desktop, all three platforms

- The same engine and spec on the desktop; `availableBrowserConnection()` and
  the Electron surface (`electron/browser-surface.cjs`, `browser-platform.cjs`,
  the Windows gate, preload `browser:*` IPC) are deleted.
- Optional headed mode (`--headed`) so the bot's browser is a real window.
- Browser profiles UI keeps its concepts (own session, shared named session)
  and gains "use my Chrome profile" (`--profile <name>`).

### 3. Watch and take over

- The browser panel renders the session's stream on a canvas and forwards
  mouse/keyboard as `input_mouse` / keyboard messages; the address bar shows
  the streamed URL.
- While a human is in control, the bot's `browser_screenshot`/`snapshot`
  return "a person is using this browser" (the one protected-field rule we
  keep, rebuilt as a check before screenshots).
- Server: the stream is reached through the harness with the session cookie
  (never a public port); desktop: loopback.

### 4. Tool-name adapter

A thin adapter presents our `browser_*` names over the `core` tools so
existing skills keep working; then the desktop docs and skills are updated to
the single vocabulary.

## Not doing

- Bundling Steel, browser-use or Playwright MCP. Power users can add any of
  them as a custom MCP server today.
- Anti-detection, proxies, CAPTCHA solving.

## Comparison (Sep 6, 2026)

| Candidate | Why not |
|---|---|
| Playwright MCP (Microsoft) | Runner-up; a config swap since both are MCP servers. 70+ tools to trim, one client per persistent profile, no stream. |
| Chrome DevTools MCP (Google) | Debug/perf focus, usage statistics to Google by default, no per-bot sessions, no stream. |
| Steel | Live view with takeover, but the self-hosted server runs one session at a time and needs an installed Chrome; a Node/Fastify service with nginx and a UI. |
| Stagehand, browser-use, Skyvern | Agents or model-driven SDKs: a second model loop under our agents. |
| browserless | SSPL / commercial licence. |
| Lightpanda | Not Chrome (partial web compatibility), AGPL. |
