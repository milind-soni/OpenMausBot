# Optional desktop organisation connection

Run the actual renderer and production desktop preload/client in a disposable
Electron window:

```sh
node scripts/verify-organization-settings.mjs
```

The script accepts no external URL. It creates its own loopback Vite preview,
fake-engine workspace, synthetic Admin HTTP server, temporary HOME and Electron
profile. Renderer requests outside the preview and fixture runtime are blocked.
It never opens the user's app, browser profile, saved connections or keychain.
Linux needs a graphical session (or `xvfb-run -a`).

The smoke checks:

- The optional organization logo and shared bot-icon grid arrive in the
  authenticated native snapshot. Selecting an icon uploads a durable local
  attachment through the real fixture runtime. Admin removal clears the logo
  and library after Refresh without changing the bot's chosen local avatar.
  Branding is excluded from the strict runtime model grant and credential store.

- Loading Settings does not enroll or open a browser. **Sign in with your
  organisation** uses the standard OpenMaus Admin; a separate custom Admin
  address remains available under **Advanced**.
- The production client opens the browser and connects automatically after
  approval. The optional verification code stays collapsed under **Security
  details**, and cancelling returns to the signed-out view.
- Synthetic browser approval yields the company name, employee email and
  approved model counts. No device token or private connection method reaches
  renderer JavaScript.
- Organisation sign-in leaves the native renderer local, including macOS
  on-device speech. A true remote workspace remains classified as remote and
  receives no local speech capability.
- The private process receives only the separate model capability, never the
  device credential used for session and backup authority.
- Disconnect has a separate confirmation. Cancel preserves the connection;
  confirm clears the saved grant and requests device revocation.
- Revoked access requires disconnecting before signing in again, without
  suggesting personal billing as an automatic fallback.
- The 390px layout has no horizontal overflow.
- A remote-origin page gets neither the organisation bridge nor Node access.
- The actual fresh app still opens its existing optional welcome flow, not an
  organisation sign-in wall. Explicit Settings → Organisation works before
  completing local provider onboarding.
- A persisted old hosted selection loads the old server's page without an
  organisation bridge. Cancelling native organisation sign-in leaves the saved
  selection byte-for-byte unchanged. Confirming through the production native
  menu opens local Organisation Settings, preserves the hosted entry and does
  not enroll automatically. Recreating the renderer from the saved choice
  stays local. A completion receipt is required, not merely an exit code.

The printed evidence directory retains `receipt.json`, `electron.log`, and
connected, narrow confirmation and in-app screenshots. Cleanup removes only
the fixture's home/profile and fake-engine workspace; no user data is changed.

This is a renderer/preload/client workflow check against synthetic HTTP
responses. It substitutes an in-memory credential store, captured browser-open
requests and a fake utility-process acknowledgement. It does **not** prove
real Admin consent, OS keychain persistence, private runtime synchronization,
native provider execution, cloud backups, public DNS/TLS or paid model calls.
Provider isolation, expiry and no-personal-fallback behavior are separately
covered by `server/managed-desktop.test.ts`. Read-only Company engine settings
and preservation of personal controls have focused renderer regressions.

## Returning from a hosted workspace

Use **Server → Sign in with organisation…** in the installed desktop app, or
**Use desktop app → Open desktop app** in Admin. The fixed
`openmausbot://organization` link opens local settings only; it carries no
credentials and does not approve enrollment. Remote pages do not gain access
to the organisation bridge. Existing hosted server selections are not reset
on an ordinary update.

When a hosted workspace is selected, the native confirmation explains that
its data stays on the server. The hosted entry remains saved. In desktop
companion mode, confirming explicitly disconnects and restarts locally; the
local Settings destination is remembered in the same encrypted write. A
failed write or cancelled dialog does not disconnect. The pending destination
is consumed only when the local Organisation panel acknowledges its mount.
Relaunch arguments exclude the consumed one-shot link so later updates cannot
replay it. Restore/retry and
stale-confirmation cases are covered by
`node --test electron/organization-entry.node-test.mjs`.

The Electron smoke uses actual menu selection, renderer navigation and a
disposable saved-environments file, but substitutes native confirmation and
credential storage. It recreates the renderer rather than installing a real
update or invoking an OS protocol handler. Companion restart/keychain behavior
is controller-tested, not a production migration claim.

2026-09-20: the extended isolated desktop workflow passed. Evidence:
`/var/folders/91/pdc4mdh53xs59x0r4z7_0qzc0000gn/T/omb-organization-ui-kdmfy4/`.
Installed-app update/protocol testing and production rollout remain separate
follow-ups; no customer workspace was changed.

2026-09-16: the extended isolated Electron workflow passed, including logo
decoding, avatar selection/retrieval and removal propagation. Evidence:
`/var/folders/91/pdc4mdh53xs59x0r4z7_0qzc0000gn/T/omb-organization-ui-ndaRQH/`.
The separate private Admin/native runtime integration also passed with branding
enabled (`/tmp/omb-desktop-integration-ql2mMS/receipt.json`). Neither test used
customer accounts or changed the operator's desktop app.
