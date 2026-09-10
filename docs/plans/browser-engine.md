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
- A stream server: JPEG frames, the active URL, tabs, and viewport metadata.
  Upstream does **not** enforce human priority. OMB owns that gate.

## Shape

```
bot turn → scoped OMB MCP proxy → profile control gate → agent-browser MCP → Chrome
owner UI ← authenticated SSE ← OMB ← loopback WebSocket frames ← agent-browser
owner UI → authenticated POST → control gate → acknowledged native input → Chrome
```

`browserIntegration()` in `server/index.ts` mounts a turn-scoped OMB proxy,
guarded by the workspace flag, bot switch, and provider's `browserMcp`
capability. Native session identity and encryption keys stay in the server.

## Steps

### 1. Headless engine (servers, and the fallback everywhere) — shipped

- `server/browser-engine.ts`: resolve the pinned agent-browser binary
  (`OMB_AGENT_BROWSER_PATH` → `$OMB_DATA_DIR/tools/agent-browser/<version>/` →
  PATH); download from the GitHub release with per-platform SHA-256 pinned in
  `server/browser-engine-release.ts` (same pattern as `antigravity-release.ts`
  and `prepare-cloudflared.mjs`); ensure Chrome with `agent-browser install`;
  report `unavailable` with the reason rather than degrading silently.
- `browserIntegration()`: when no desktop connection exists and the engine is
  available, return `{command: <binary>, args: ["mcp", "--tools", "core",
  "--no-webmcp"], env: {AGENT_BROWSER_SESSION, AGENT_BROWSER_RESTORE: <stable-key>,
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

### 2. Desktop, all three platforms — shipped

- The same engine and spec on the desktop; the Electron surface
  (`electron/browser-surface.cjs`, `browser-host.cjs`, `browser-platform.cjs`,
  the partition cleanup, the connection/control sync, the Windows gate, the
  preload `browser:*` IPC, the snapshot bundle) and the server's per-turn
  capability registry are deleted. Bot and profile deletion clear the
  engine's session state on the server itself, through the same durable
  cleanup journal. Settings and the bot's Browser panel offer a one-click
  install of the engine (`POST /api/browser-engine/install`).
- The app keeps browsers headless; the live panel is the visible surface.
  Importing an operator's Chrome profile remains out of scope.

### 3. Watch and take over — implemented, pending release

- Two compact chrome rows: tabs and a top profile button; navigation,
  address, takeover, and overflow below. Profile management and typing/paste
  open on demand. No permanent status dashboard around the page.
- `BrowserLive` proxies only frame/status/tab/URL events. ACKs follow decoded
  rendering, including identical image data. At most one pending frame waits
  for SSE backpressure; slow/disconnected viewers are closed. Default 15 fps.
- `BrowserRuntime` gates **all** browser tool calls and transcript captures
  for the shared session. Takeover first blocks new calls, then drains the
  accepted ones. Human input uses fixed native HTTP commands that await CDP
  completion, not fire-and-forget WebSocket input. Hand-back waits for them.
- A timed-out action has an uncertain outcome. Explicit Restart browser
  closes the native session before recovery; it keeps saved logins. It is
  refused while bots sharing that browser are working.
- Owner/admin-only endpoints use existing authentication, CSRF and session
  revocation checks on desktop and self-hosting alike. Browser frames never
  enter the client-readable global events feed. Native stream ports remain
  loopback-only. Other viewers are hidden during human control.
- Own, shared, and temporary profiles work on the web too. Temporary browsers
  last for one server run, are not saved, and close on deletion/profile exit.
  Profile edits include a stale-list check; deletion removes only that exact
  profile's saved state. Do not use upstream `state clear --all` for this.
- These controls gate OMB's browser tools, not arbitrary host shell access.
  Browser profiles are login separation, **not** OS security sandboxes.

See [the native verification recipe](../verification/browser-live.md).
Recording's `--fps 60` is separate from live streaming and needs ffmpeg;
recording controls are intentionally not added to the live browser chrome.

### 4. Tool-name adapter — dropped

The engine's `agent_browser_*` names are the vocabulary everywhere now; the
system prompt teaches them. No adapter.

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
