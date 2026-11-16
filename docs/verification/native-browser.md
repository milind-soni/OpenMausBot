# Native desktop browser

The native desktop choice uses Electron website views beneath the existing CDP
browser service. It reuses the Computer panel, browser toolbar, tools, profiles,
takeover and hand-back, uploads, downloads and sign-in prompts. It does not control
the person's ordinary Chrome or desktop.

The existing experimental browser choice shows **Native desktop** only when the
local desktop process advertises it. The saved configuration remains
`browserEngine: { engine: "chrome", nativeDesktop: true }`; older releases can read
the `chrome` value. The default browser choice stays unchanged. A remote viewer
of a native profile uses the existing image stream, while the local desktop
renders its website directly. My Chrome retains its existing implementation.

Profile semantics follow the existing service: Own browser is per bot, a shared
profile shares live tabs and sign-ins, and a guest saves no sign-ins. These website
sessions are separate from the app's privileged renderer and ordinary Chrome.
Clean close preserves cookies and up to eight HTTP(S) tabs. A restart requested
by the person starts blank. Local files must be opened from their message again;
file grants and unsaved forms are not restored after closing the app.

## Isolated qualification

Install the locked development dependencies and use an explicit Electron
development executable matching the package's pinned version. Never point this
recipe at an installed OpenMausBot executable or a real app profile.

```sh
pnpm typecheck
pnpm lint
pnpm check:electron
pnpm i18n:check
node --test electron/native-browser-pool.node-test.mjs
```

On PowerShell:

```powershell
$env:OMB_ELECTRON_PATH = 'C:\path\to\electron\electron.exe'
pnpm test:native-browser
```

On macOS or Linux:

```sh
OMB_ELECTRON_PATH=/path/to/electron pnpm test:native-browser
```

The command builds the server and a standalone utility-process test worker. It
creates its own app, home and website sessions, uses hidden windows, and sends
traffic only through a synthetic local SOCKS/HTTP fixture. It makes no model calls
and does not open the user's app or control the screen. `OMB_NATIVE_TEST_TMP` may
select the parent of the disposable evidence folder printed on completion.

It exercises the real coordinator, private utility channel, backend and browser
service: owned target/frame identity, snapshots, fill/click, hash navigation,
popup opener messages, workers, profile isolation, native metadata without image
frames, human ownership, original large HTML with relative assets, tab reuse,
cookie retention and explicit erasure. The ordinary message-file route tests
cover current owner/thread authorization, capability rotation and disconnect
while opening. Native pool tests cover cancelled creation, physical/synthetic
input and accepted-view activity. Viewer tests cover grants arriving after a
viewer has left.

## Desktop acceptance

Run the full app against a disposable fake-engine home as described in the
[verification entry](README.md), with the desktop parent hosting that exact server.
Do not test mutations against a running personal app.

1. Enable the native choice while idle; changing engines while a browser is busy
   must keep the existing refusal. An unchanged choice must not restart it.
2. Open a linked original HTML file from a direct bot message. Interact with its
   form while the chat and input remain usable beside the Computer panel.
   Reopen the same link and verify there is one matching tab.
3. Check Midnight and Daylight, a narrow window, panel resizing, a dialog/menu
   over the page, and Shift+Escape returning to the address field.
4. Take and hand back control from two views of the same person, then from a
   different person. The first unacknowledged click is consumed. No cancelled
   bot action may run later. Continuous native typing keeps the ordinary hold
   alive; leaving the page still permits the ordinary idle/grace release.
5. Check the same page from a remote canvas viewer, including file upload,
   download, HTTP sign-in, select popup and page dialog. Repeat Own/shared/guest
   profile switching and deletion. My Chrome must continue using its old route.

The automated fixture is behavioral evidence, not full-app visual acceptance.
Run these desktop checks and the platform CI lanes before describing a release
as qualified on macOS or Linux. Do not substitute a local adapter's earlier
desktop acceptance for this source branch's evidence.
