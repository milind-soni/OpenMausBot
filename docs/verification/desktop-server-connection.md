# Desktop server connection

Run the real Settings connection component in disposable Electron windows:

```sh
node scripts/verify-server-connection.mjs
```

Use the repository's installed dependencies, including the Electron binary.
Linux needs a graphical session (or run the command through `xvfb-run -a`).
The script creates its own loopback Vite preview, temporary HOME and Electron
profile. It accepts no server URL and blocks requests outside that preview.
It never opens the operator's app, server list, credentials or browser profile.

The smoke mounts `RemoteComputerSection` with the real styles and
`electron/preload.cjs`. It checks:

- A full custom HTTPS pairing link, including its 12-character code, reaches
  `environments:add-from-link` unchanged and never calls companion pairing.
- Duplicate submissions are blocked while a response is pending.
- Cancellation, rejection and retry restore a usable form; Electron's error
  wrapper is removed from the visible message.
- Desktop companion mode still sends a normalized six-digit code through
  `desktop-remote:pair`.
- The 390px layout has no horizontal document overflow.
- A page outside the declared local origin receives neither connection bridge
  nor Node access from the production preload.

The printed evidence directory retains `receipt.json`, `electron.log`, and
desktop/narrow screenshots. Successful cleanup removes only the temporary
home and profile. Expected fake IPC rejection messages appear in the log.

This verifies actual renderer/preload dispatch, with fixture IPC handlers
substituting native confirmation, server persistence and navigation. It does
not prove a real pairing exchange, session persistence, or public DNS/TLS.
The existing production handler still performs native confirmation and opens
the server's pairing page; its URL/state helpers are checked separately with
`node --test electron/environments.node-test.mjs`. Do not report this offline
smoke as an authenticated connection to a customer's server.
