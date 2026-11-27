# Phone web app installation

The HTML links a standalone web manifest and existing-brand PNG icons. The
static server serves the manifest with `application/manifest+json`. Its start
address, scope and identity stay at the workspace root with no pairing tokens.
Safe-area padding keeps the existing app layout away from the notch and home
indicator; desktop browsers report zero insets.

## Isolated browser checks

```sh
pnpm exec vitest run scripts/testing/web-app-assets.test.ts
pnpm exec vitest run server/index.test.ts -t 'serves packaged UI'
pnpm exec vite build
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/web-app-ui.e2e.test.ts
```

The UI recipe launches a disposable verification server with fake engines and
the production UI build. It owns a new Chrome profile and installs the pinned
test browser if necessary. It checks Chrome's parsed manifest and installability
errors, portrait and landscape safe areas, touch text that avoids automatic
focus zoom with an aligned mention mirror, a real composer send and reload
without duplicate messages, and the absence of a service worker or offline
cache. Screenshots and browser results are saved beside the fixture server log.
`OMB_WEB_APP_BUILD` can select an already-built UI directory. Neither the user's
browser profile nor live OpenMausBot data is used.

These automated checks do not prove physical phone installation. Follow the
[phone installation guide](../phone-web-app.md) in a disposable workspace for
device qualification:

- iPhone Safari: Add to Home Screen, verify the icon and name, then launch a
  standalone window without Safari's address bar. Confirm that chat and Settings
  stay clear of the notch and home indicator in both orientations.
- Android Chrome: Install app, launch from its icon and verify the same layout.
- Pair the installed window if needed; send a fixture message, quit and reopen,
  then confirm one stored message and its reply. Check that an unpaired or
  revoked window must pair again.
- Background and resume the app, then focus the composer with the software
  keyboard open. Confirm that the composer and Send remain reachable.
- Disconnect and reconnect to the running fixture server; verify the existing
  connection status and recovery rather than expecting offline chat.
- Remove only the test installation and disposable workspace afterward.

Record browser and OS versions and whether each check used a simulator or a
physical device. No real account, paid provider or production server is needed.

## Layout evidence

These production-renderer captures use a 390px Chrome viewport with synthetic
44px top and 34px bottom safe areas, and the same disposable fake-engine setup.
The before capture uses unchanged main's HTML and CSS. Neither is a physical
phone screenshot.

| Before: no explicit phone safe areas | After: controls inside the usable area |
| --- | --- |
| ![Original phone layout](assets/phone-web-app/before-390.png) | ![Phone layout with safe-area padding](assets/phone-web-app/after-390.png) |

## iOS simulator qualification

On 2026-10-11, the production build was tested in a newly created iPhone 17 Pro
simulator running iOS 26.5 (23F77), hosted on a physical Mac with macOS 26.6.2.
Safari's **Add to Home Screen** showed the OpenMausBot name and icon with **Open
as Web App** enabled. Launching that icon opened a standalone window without a
Safari address bar. The server and model were disposable loopback fixtures.

The onscreen keyboard was used to enter and send `Ios`. The real messages API
recorded one matching user message and a settled fake-engine reply. Keyboard
dismissal restored the header below the status bar; the composer stayed reachable
while typing. Landscape rotation and Home Screen background/resume preserved
the chat and kept its controls clear of the cutout and home indicator. Settings
opened with reachable controls in both orientations. Terminating the web app
and reopening its Home Screen icon preserved the chat, with one stored `Ios`
message and no duplicate send.

The keyboard check caught Safari's automatic zoom of the original 15px editor.
The touch editor and its mention mirror now use 16px; user zoom is still enabled.
A production-renderer regression test failed at 15px and passed after this fix.

![Safari Home Screen installation](assets/phone-web-app/installed-ios.png)
![Standalone chat after keyboard dismissal](assets/phone-web-app/chat-ios.png)
![Standalone landscape chat](assets/phone-web-app/landscape-ios.png)

This was a simulator, not a physical iPhone. Physical iPhone and Android
installation, remote HTTPS pairing/revocation and interrupted-network recovery
remain device-checklist items; none is claimed as performed here.
