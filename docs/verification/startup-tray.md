# Loading screen and Windows system tray

Run the lifecycle regressions and disposable Electron fixture:

```sh
node --test electron/startup-tray.node-test.mjs electron/single-instance.node-test.mjs electron/server-supervisor.node-test.mjs
node scripts/verify-startup-tray.mjs
```

The fixture creates a temporary Electron profile and blocks network access.
It opens the actual loading screen, captures `startup-screen.png`, clicks its
real close button, mounts a disposable workspace, verifies it stays hidden,
then restores it through the production tray controller. It selects the real
Quit menu item programmatically. The printed evidence directory contains a
receipt, progress log, screenshot, and disposable profile. No user workspace,
server, credentials, computer-control driver, or installed application is used.

The fixture launches visible test windows. Do not launch Electron with
`windowsHide: true` here: Windows would suppress the windows whose visibility
the test is meant to verify. Linux requires a graphical session such as Xvfb.
Run on Windows to exercise the actual Windows tray implementation.

Unit tests additionally cover minimized/maximized restoration, renderer
failure, a renderer that never mounts, quit during startup, missing-tray
fallback, and the existing server shutdown and updater instance-lock paths.

These checks do not exercise physical clicks on the Windows notification-area
menu, the full packaged app, update downloads, or helper-console suppression.
For package acceptance, start a packaged Windows build in an isolated profile,
close during startup and after loading, reopen from the tray and a second
launch, and use **Quit OpenMaus Bot**. Verify owned helpers exit and the tray
icon disappears. Repeat with an update-driven restart.
