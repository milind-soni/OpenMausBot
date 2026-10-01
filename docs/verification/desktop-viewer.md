# Remote desktop viewer

Build and run the isolated server/browser fixture on Linux or macOS:

```sh
pnpm build
node --experimental-strip-types scripts/verify-desktop-viewer.ts
```

To reuse installed browser tools, set `OMB_AGENT_BROWSER_PATH` and
`AGENT_BROWSER_EXECUTABLE_PATH` explicitly. The fixture prints its temporary
data directory and persistent server log. It launches the standard fake-engine
server, synthetic Docker/SSH executables restricted to the fixture, and
an RFB desktop on a randomly allocated loopback port. Browser profiles and
server data are disposable; it never contacts the host Docker daemon or a real
desktop. Cleanup closes the owned browser, server and RFB sockets.
The synthetic Docker and SSH executables are POSIX shebang scripts; this standalone
recipe does not cover Windows. It is a manual smoke command, not part of
`pnpm test` or the renderer CI job.

The fixture reuses the shared HTTP and browser helpers. Keyboard and clipboard
checks wait for received RFB events, with bounded waits. Set
`OMB_UI_EVIDENCE_DIR` to retain screenshots in a chosen directory, as in the
other renderer recipes; otherwise they stay beside the printed server log.

The script pairs the browser through the real HTTP API, follows the same
status and WebSocket routes as a remote admin, and verifies:

- The built noVNC page displays the synthetic desktop's pixels.
- Paired status returns a viewer link on the app origin, without a password.
- The Keyboard panel sends text, newline, Unicode keysyms and Ctrl–Alt–Del.
- Clipboard text arrives from the desktop; editing or clearing the field syncs
  automatically without a Send button or device clipboard permissions.
- The noVNC background matches its parent in dark and light themes.
- The Send button follows Foundry's enabled and disabled text colors.
- Automatic 95% fit and full-height, unframed fullscreen (when supported)
  work, including restoring the normal fit after leaving fullscreen.
- The animated sidebar leaves equal margins when collapsed; fullscreen has
  no margins. Closed controls are inert and tooltips use native titles;
  hiding or showing them moves focus to the opposite toggle.
- The clipboard header keeps its title centered beside a compact close button.
- Panels use the app's shared menu motion, including reduced-motion behavior.
- The panels fit phone and short landscape viewports; dark and light screenshots
  show the built UI using the app's skin tokens.
- Reconnect opens a new working desktop connection.
- Page exit aborts a pending connection request; a persisted-page restore
  opens a fresh connection.
- The same built viewer opens a VPS through the real join route and a synthetic
  loopback SSH forward; two simultaneous joins share one tunnel, and reconnect
  reuses it without a public viewer port.
- Changing the link target disconnects the previous desktop and clears its
  keyboard/clipboard drafts.
- Logout closes the already-open WebSocket.
- noVNC notices and their source pointer are served from the built UI.

The focused server tests exercise shared, per-bot and pool target selection,
HTTP and upgrade authentication, client-scope and foreign-origin refusal,
VPS connection retention/release, session revocation/expiry, shutdown and revocation during inspection,
established-connection shutdown, disconnect during inspection, target deletion,
upstream rejection/timeouts, and stripping workspace credentials from the
upstream request:

```sh
pnpm exec vitest run server/routes/desktop-viewer.test.ts server/container-computer.test.ts server/request-auth.test.ts server/vps-computer.test.ts
pnpm exec vitest run scripts/testing/verification-docs.test.ts
```

The page is built with the app; VM-controlled HTML and JavaScript never run
under the app origin. The proxy forwards only the RFB WebSocket, never workspace
cookies or tokens. Revocation closes connections immediately; expiry and target
availability are rechecked every five seconds.

These checks use a synthetic RFB server and Chromium. They do not claim a
real container or VPS/SSH server, Tailscale TLS connection, Safari/iPhone, or native Electron
viewer acceptance. Local owner requests retain the existing direct viewer
URL and Electron cookie isolation.

VPS tunnel tests retain multiple viewers, release each once, preserve native
viewer ownership and reclaim remote-only tunnels after the 30-second reconnect
grace period. Provider-hosted Cloud URLs are outside this proxy; they can also
use WebRTC.

The consolidated `public/novnc-NOTICE.txt` contains the source and MPL-2.0
links plus the bundled Pako and DES notices. Vite includes this static asset
in `dist`, which existing web, npm and desktop packaging already ship. The
fixture checks the served notice against that file and the dependency notices.
The root `NOTICE` and a small noVNC link in the viewer's lower-right corner
point to it. The link stays available with the controls collapsed, opens in a
new tab and has a native tooltip. No custom build step is needed.
