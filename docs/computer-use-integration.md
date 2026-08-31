# Computer use & browser use in OpenMausBot

Decision doc, 2026-08-12; browser-use sections revised 2026-08-31 when the
embedded WebContentsView browser was replaced by BetterWright. How bots in
OpenMausBot get local computer use and
browser use. macOS and packaged Ubuntu x64 builds use an out-of-the-box,
release-pinned provider; source/dev Ubuntu may use a separately installed provider. Based
on a survey of OSS chat-app MCP hosts, macOS control servers,
browser-automation stacks, and the local `cua` / `axstream` code on this
machine.

## TL;DR architecture

```text
Electron main process
├── CUA host  ──spawns──▶  cua-driver (bundled on macOS and packaged Ubuntu x64)
│     platform permission boundary               │ unix socket (private)
└── server/ harness (drivers spawn agent CLIs with --mcp-config)
      ├── computer-proxy-local.ts  ──▶ forwards MCP tool calls to driver socket
      ├── computer-proxy.ts (existing) ──▶ remote/cloud box
      └── betterwright mcp  ──▶ policy-guarded BetterChromium (browser use)
```

- **Plugins = MCP servers over stdio.** The Plugins panel toggles which MCP
  servers get injected into each bot's `--mcp-config`. Same pattern as Claude
  Desktop / Cherry Studio / LibreChat.
- **Local desktop use = `cua-driver`**. macOS packages the Rust Mach-O in app
  Resources; Ubuntu x64 packages the certified 0.19.3 ELF plus its cursor-theme
  sidecar outside ASAR. Both remain paired with the application release. This
  applies to the Ubuntu 24.04 GNOME/Xorg beta and guarded GNOME/Wayland beta;
  remote/cloud boxes and the isolated Local VM remain separate providers.
  NOT Swift — the Swift file everyone remembers
  (`examples/embedded-host-macos/ExampleAgentHarness.swift`) is a 165-line
  reference host showing the embedding pattern, not the driver.
- **Browser use = BetterWright.** The `browser` integration spawns
  `betterwright mcp` (a dependency of this repo) inside the bot's agent
  process. BetterWright runs its own persistent, policy-guarded browser with
  one profile per bot (`BETTERWRIGHT_PROFILE=bot-<id>`, or a named shared
  profile), a credential vault with trusted fill, and a live-view handoff URL
  the bot shares when the user needs to sign in or take over.

## Local desktop use: CUA only — Electron owns the driver lifecycle

**Decision (Milind, 2026-08-12): CUA is the ONLY local desktop-control provider.
No cliclick, no robotjs/nut.js, no Python computer-server, no fallbacks.**
All local desktop-control and input actions go through the validated
`cua-driver` binary. Linux screen preview uses the supported Xorg or
user-initiated XDG portal capture path and is not a control provider. This rule
does not replace remote/cloud boxes or the isolated Local VM provider. Local
alternatives evaluated and rejected:

The Ubuntu GNOME beta uses the same official CUA provider with the Phase 5
supply-chain contract tracked in [#113](https://github.com/milind-soni/OpenMausBot/issues/113): pinned archive
and inner hashes, exact archive allowlist, outside-ASAR resources, full notices/SBOM, no runtime download/update,
and fail-closed packaged discovery. Electron still owns a private embedded daemon/socket, and the harness only
receives the validated MCP proxy contract. Xorg is tracked in [#79](https://github.com/milind-soni/OpenMausBot/issues/79);
GNOME/Wayland additionally requires WinRects v8 plus the exact Cua health-report contract tracked in
[#109](https://github.com/milind-soni/OpenMausBot/issues/109).

| Option | Verdict |
| --- | --- |
| cua `computer-server` (Python/FastAPI) | ✗ 200MB+ frozen Python, second TCC prompt under wrong identity |
| axstream / cliclick / robotjs-class | ✗ rejected — CUA-only policy |
| **cua-driver binary, embedded mode** | ✓ THE provider: one contract, 20+ tools, its own stdio MCP proxy + socket daemon + TS SDK (`@trycua/cua-driver`), agent-cursor overlay, permission tooling |

### The rules (from `cua/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md` — read it end to end)

1. **Spawn from the Electron main process, never from the server/gateway
   layer.** macOS TCC attributes a spawned child to its "responsible process".
   Spawned from Electron main → the grant is OpenMausBot's, users see ONE
   prompt named OpenMausBot, and the bundled driver inherits it. Spawned from
   a Node gateway/daemon → the identity silently becomes the gateway's and
   `check_permissions` cannot detect the misattribution. The harness must ask
   Electron main for the driver socket path over IPC, not spawn the driver.
2. Use `EmbeddedCuaDriverHost` from `@trycua/cua-driver`
   (`libs/cua-driver/typescript/src/embedded.ts`, Electron helpers in
   `src/electron.ts`: `requestMacOSPermissions`, `hasRequiredMacOSPermissions`,
   `openMacOSScreenRecordingSettings`). Working reference:
   `typescript/test/electron-main-fixture.mjs`.
3. Env: `CUA_DRIVER_EMBEDDED=1` (exact value) + `CUA_DRIVER_HOST_BUNDLE_ID`.
   Permission mode `standard`.
4. Lifecycle: defer `before-quit` until `await embedded.stop()`; after a TCC
   grant change, destroy clients → `restart()` → reconnect (macOS caches TCC
   per process).

### macOS packaging target

- Ship the binary at `OpenMausBot.app/Contents/Resources/cua-driver`,
  **outside the ASAR**, executable bit preserved (electron-builder
  `extraResources`).
- **Re-sign it with our Team ID** before signing + notarizing the app (the
  installed copy is signed by trycua `YCK386LBJ7`). Biggest new build step.
- Info.plist: `NSAccessibilityUsageDescription`,
  `NSScreenCaptureUsageDescription` (mirror `/Applications/CuaDriver.app`'s
  strings).
- Onboarding: check → explain in-app → deep-link Settings panes
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`
  and `?Privacy_ScreenCapture`). Expect macOS 15's ~monthly screen-recording
  re-prompt; the `persistent-content-capture` entitlement is Apple-gated and
  not realistically available to us.

### MCP exposure: the official `cua-driver mcp` proxy (no custom proxy)

Do NOT hand-roll a socket proxy. The driver ships its own stdio MCP proxy:

```
cua-driver mcp                              # standalone (attaches to running daemon)
cua-driver mcp --embedded --socket <path>   # embedded (host-owned daemon)
```

It speaks line-delimited JSON-RPC 2.0 on stdin/stdout, executes nothing
itself, and forwards to the host-owned daemon. Verified round-trip against the
installed `CuaDriver.app` binary:
`tools/call get_screen_size` → `{"width":1512,"height":982,"scale_factor":1}`.

So the harness just adds one entry to a bot's `--mcp-config`:

```jsonc
{ "mcpServers": { "computer": {
    "command": "<cua-driver binary>",
    "args": ["mcp", "--embedded", "--socket", "<socketPath>"],
    "env": { "CUA_DRIVER_EMBEDDED": "1", "CUA_DRIVER_HOST_BUNDLE_ID": "com.opengrokbot.app" }
} } }
```

Electron main writes that descriptor to
`<userData>/cua-connection.json` (see `electron/cua.mjs`); the harness reads
it and injects the block. The driver's own non-idempotent-action safety and
the `ax → ax_fg → cgevent → cgevent_fg → cgevent_hid` delivery ladder
(background pid-addressed input first — does not steal the user's cursor) are
handled inside the binary; the host adds nothing.

Driver tool surface (per `cua-driver list-tools`): start_session, click,
double_click, right_click, drag, scroll, type_text, press_key, hotkey,
move_cursor, get_window_state, get_desktop_state, get_accessibility_tree,
list_windows, list_apps, launch_app, bring_to_front, check_permissions,
get_screen_size, zoom, screenshot. AX element paths are preferred over pixel
coordinates and work on backgrounded/hidden windows.

### Policy: CUA is the only computer-use path

No axstream, no cliclick, no robotjs/nut.js, no Python computer-server. If a
capability is missing (e.g. OCR-anchored clicking, macro record/replay), it is
added to cua-driver upstream or requested as a driver tool — never bolted on
beside it. This keeps one TCC identity, one binary to sign/notarize, and one
behavior contract.

## Browser use: BetterWright (revised 2026-08-31)

The original tier 1, an embedded `WebContentsView` pool driven over
`webContents.debugger` with a loopback host and per-turn capability tokens,
shipped and was then replaced wholesale by
[BetterWright](https://github.com/BetterWright/betterwright) 2.0.0. What the
replacement buys:

- **One MCP server instead of a proxy chain.** `browserIntegration()` hands
  drivers `betterwright mcp` (spawned from `node_modules` with
  `ELECTRON_RUN_AS_NODE=1`). The old
  browser-proxy → loopback host → WebContentsView pipeline, its capability
  mint/revoke lifecycle, and the vendored `playwright-injected` snapshot
  bundle are gone.
- **BetterChromium provisions on first run, not at install.** npm staging uses
  `--ignore-scripts`, so a clean machine has the CLI but no browser. The
  server runs `betterwright setup` (idempotent, artifact version pinned by
  the package) the first time the feature is on — at boot, on enable, or on
  the first mount — into the shared `~/.betterwright`, where a user who
  already runs the CLI has it installed anyway.
- **Identity model carries over.** A bot with no profile gets
  `BETTERWRIGHT_PROFILE=bot-<id>`; a named shared profile maps to its stable
  partition id (the immutable identity rule from #567); `guest` stays `guest`.
  Profile state lives under `~/.betterwright/browser/profiles/<name>`;
  deleting a profile or a bot removes its directory after
  `betterwright close --profile`.
- **Sign-in and takeover move out of the app.** The bot calls
  `browser_handoff`, which returns a token-guarded live-view URL the user
  opens to watch or take control; `browser_login` fills vault credentials
  without exposing them to the model. The in-app Browser panel and its
  who-is-driving lease are removed. This also clears the old tier-1 limit:
  BetterWright's browser is a real Chromium fork, so Google OAuth works.
- **Toolset.** `browser` (Playwright JS with snapshot/aria-ref semantics),
  `browser_batch`, `browser_login`, `browser_download`, `browser_handoff`,
  `browser_doctor` — self-describing over MCP, no bespoke toolset to
  maintain.

The extension-bridge ("use my real Chrome") and `@playwright/mcp` tiers were
never built and are no longer planned; BetterWright's provider options cover
remote/CDP browsers if that need returns.

## Rollout order

1. `computer-proxy-local.ts` + spawn `cua-driver mcp` directly from Electron
   main in dev (unsigned dev builds inherit the terminal/Electron grant).
2. Permission onboarding UI (Plugins panel → "Computer" plugin card: status,
   grant buttons, deep links).
3. Embedded browser pane + a minimal CDP toolset (navigate / snapshot /
   click-ref / type / screenshot) exposed as the "Browser" plugin.
   *(Shipped, then replaced by BetterWright — see the browser-use section.)*
4. Packaging: extraResources + re-sign + notarize; wire
   `EmbeddedCuaDriverHost` for production.
5. Later: axstream-style macro teach/replay. (The extension-bridge and
   playwright-mcp ideas are retired with the BetterWright move.)
