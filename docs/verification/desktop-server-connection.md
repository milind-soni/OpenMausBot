# Desktop server connection

Run the real Settings connection component in disposable Electron windows:

```sh
node scripts/verify-server-connection.mjs
```

Use the repository's installed dependencies, including the Electron binary.
Linux needs a graphical session (or run the command through `xvfb-run -a`).
The script creates its own loopback Vite preview, temporary HOME and Electron
profile. It accepts no server URL and blocks requests outside that preview
and the isolated fake-engine server it starts.
It never opens the operator's app, server list, credentials or browser profile.

The smoke mounts `RemoteComputerSection`, `ConnectedWorkspacesSettings`, and
`DesktopWorkspaceSwitcher` with the real styles and `electron/preload.cjs`.
It also opens the real app shell against a disposable fake-engine server.
It checks:

- A full custom HTTPS pairing link, including its 12-character code, reaches
  `environments:add-from-link` unchanged and never calls companion pairing.
- Duplicate submissions are blocked while a response is pending.
- Cancellation, rejection and retry restore a usable form; Electron's error
  wrapper is removed from the visible message.
- Desktop companion mode still sends a normalized six-digit code through
  `desktop-remote:pair`.
- The 390px layout has no horizontal document overflow.
- The hosted-workspace form accepts a hostname/address or pairing link and an
  optional name. Cancellation retains input; confirmed connections preserve
  the existing list and exclude the pairing code from saved connection data.
- The production native menu's Connect item requests Settings; its saved
  workspace items dispatch fixed IDs. Settings can switch connections and
  cancel or confirm forgetting just one saved connection.
- The local app opens Servers as a top-level Settings page, even
  before local provider onboarding. Native requests also clear stale Settings
  searches, so the requested page actually becomes visible.
- A page outside the declared local origin receives no saved-list/mutation
  bridge or Node access. Its workspace bridge contains only `state` (current
  name, not the list) and `menu` (the user selects in Electron's native menu).
- Computer access starts off, selected folders start read-only, cancelled
  confirmation grants nothing, and Stop sharing immediately updates the state.
- With the feature flag absent, no sharing controls appear, including through
  an old post-pair deep link. The smoke then explicitly enables the flag only
  in its disposable server to exercise the unfinished feature's enabled path.
- The post-pair deep link opens access for the correct saved workspace. Hosted
  renderers receive **no** `computerSharing` permission bridge.
- A real pairing exchange sets Chromium's HttpOnly session cookie. The native
  connector registers with the real fixture server using `session.fetch`, then
  revokes the registration. Its cookie is never copied into renderer JavaScript.

The printed evidence directory retains `receipt.json`, `electron.log`, and
desktop/narrow/in-app screenshots. Successful cleanup removes only the
temporary home, profile and server data. Expected fake IPC rejection messages
appear in the log.

This verifies actual renderer/preload dispatch, with fixture IPC handlers
substituting native confirmation, server persistence and navigation. It does
not prove public DNS/TLS or a live computer-control session. The native
connector portion does prove a real pairing exchange and cookie-authenticated
registration; filesystem and MCP execution are covered below.
Native menu items are selected programmatically; this is not a physical
mouse/keyboard test of the operating system's popup.
The existing production handler still performs native confirmation and opens
the server's pairing page; its URL/state helpers are checked separately with
`node --test electron/environments.node-test.mjs`. Do not report this offline
smoke as an authenticated connection to a customer's server.

## User flow

In a desktop build with this feature, choose the server dropdown above the
sidebar search → **Connect to a server…**, or open **Settings →
Servers**. Enter the server's HTTPS address or full pairing link and an
optional name. Confirm the host in the native dialog, then complete pairing or
email sign-in on that server. To generate an owner link without the CLI's
phone wizard, run `npx openmausbot pair --label "My desktop"` on the server.
Treat this link as a secret. Existing limited-access links retain their limits.

Select **This computer** or a saved hosted workspace to switch. Each origin
keeps its own session, bots, chats, provider credentials and settings. **Forget**
signs this desktop out and removes its saved connection, not the server's bots
or data. The server must remain running independently.

The dropdown renders in the server's own UI, so both desktop and hosted UI
need the update for the in-page control. When connecting to an older hosted
version, the native **Server** menu remains available to switch back or open
local connection Settings. Remote pages cannot enumerate the desktop's saved
connections or directly invoke switching, forgetting, or host-only controls.

## Optional computer sharing

**Computer sharing is disabled by default pending security hardening.**
Connecting and switching hosted workspaces still works, but does not offer
local file, terminal, or screen access. The flow below is maintainer-only
verification with `features.sharedComputers: true` on both servers, not a
recommended production setup or a Settings switch.

After pairing or signing in successfully, a native **Share this computer?**
dialog offers **Choose access** or **Not now** (the default). This choice is
remembered for that workspace identity and paired session, not repeated on
every switch. A different sign-in or server identity requires a new review.
Older servers need updating before they advertise this capability.

**Choose access**, or **Settings → Servers → Computer access**:

- Pick specific folders. They start read-only; **Allow edits** permits create
  and hash-guarded overwrite, not delete. Paths stay inside the chosen folder;
  symbolic/hard links and the desktop's own credential/profile storage are
  refused. Files are limited to 256 KiB per operation. This is a file-transfer
  interface, not a mounted filesystem or a sandbox for hostile local processes.
- **Unrestricted terminal** is a separate, broad opt-in: commands run as the
  desktop user and can read/write/delete outside those folders, including
  credentials. No inherited API-key environment or shell startup files; that
  does **not** confine commands. Maximum 30 seconds and 256 KiB output per call.
- **Computer control** is a separate broad opt-in: the official local Cua MCP
  can observe and operate logged-in apps, outside shared-folder boundaries.
  Local control and OS permissions must already be enabled. A local resource
  lease prevents concurrent calls with local bot turns and honours human holds.
  Between calls, another actor can change the screen: observe again before acting.

Saving requires a native confirmation naming the exact HTTPS workspace and
permissions. Grants belong to the workspace's bots, not a single bot. Shared
content may reach that server's model provider. Nothing is granted merely by
connecting the workspace.

The connector runs in Electron main, outbound to the paired server; there is
no exposed local listener. Every request needs the live paired session plus a
separate connector secret. The desktop—not the server—checks each operation
against local grants. Grants are local, owner-only files and contain no pairing
code. File grants cannot expose Electron profile storage, including these grants.

Agents use `list_shared_computers` then `shared_computer`. They receive folder
IDs/names, not local absolute paths. A bot's turn capability must still be live
when a request is delivered and while it runs. Offline or uncertain operations
are never automatically replayed, and never fall back to the server filesystem.
Server restart clears the in-memory queue; the desktop reconnects without
replaying actions. Polls do not hold the workspace-backup maintenance gate.

Access persists across workspace switches while the desktop is open. **Stop
sharing**, **Forget**, revoked pairing, or closing the desktop stops the
connector. Running commands are cancelled where possible; a native action
already admitted by Cua may have completed. Inspect uncertain outcomes before
retrying. A sleeping/offline laptop cannot service requests.

The local feature flag is rechecked before reconnecting a saved grant,
accepting consent, dispatching a remote job, and on the existing one-second
job lease. A disabled or unreachable local server aborts the connector;
an in-flight check may take up to its three-second request deadline. Restart
the desktop after re-enabling the flag. Turning it off does not erase grants,
and a native operation already admitted may have completed.

## Connector and authority tests

```sh
pnpm exec vitest run server/shared-computers.test.ts server/shared-computers.e2e.test.ts server/shared-computers.gate.test.ts
node --test electron/shared-computer-access.node-test.mjs
```

The **Shared terminal smoke** workflow runs the native terminal tests and this
real-connector test on Windows. It covers ordinary cmdlets, quoted and Unicode
command text, leading declarations, pipelines, return/exit status and process
revocation. Windows PowerShell prioritizes its own modules while retaining the
rest of its resolved module search path. No new command restrictions or approval
prompts are introduced; the existing grants, timeout and cancellation remain.

The end-to-end test starts a **real isolated server**, pairs a desktop, opens
a fake-model turn, and launches the **real agents MCP process** with that
turn's capability. It reads/edits fixture files and runs a harmless terminal
command through the real outbound connector. It checks read-only denial,
traversal denial, per-session/secret ownership, cookie CSRF, local-control gate
rejection for remote sessions, in-flight revocation and durable access-off.
It writes a redacted receipt beside the fixture server log.

Unit tests cover turn cancellation, offline sessions, one-job delivery/no
replay, host-screen resource leases and human takeover, path/link/size limits,
protected desktop storage, terminal cancellation, and the persistent official-
style Cua MCP handshake/image transport using a stand-in. They do not operate
the user's screen or prove real Cua actions on each supported OS. No live VPS,
public HTTPS, Windows desktop, or macOS screen permission was exercised by this
recipe. Run those release smoke checks separately before claiming coverage.
