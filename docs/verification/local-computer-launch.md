# Local computer helper launch

The host CUA gate must run as a headless Node process even inside a packaged
Electron app. Without `ELECTRON_RUN_AS_NODE=1`, spawning `process.execPath`
can launch another desktop instance; its single-instance handler then shows
and focuses the existing OMB window instead of answering MCP requests.

Run the isolated regression:

```sh
pnpm exec vitest run server/local-computer.test.ts \
  server/local-computer-proxy.test.ts server/mcp-bridge.test.ts \
  server/system-prompt.test.ts server/local-routing.test.ts
```

The proxy test builds the production connection descriptor inside both Node
and the real Electron executable. It then starts that descriptor against an
inert MCP child and a disposable loopback control endpoint, with a temporary
home. It asserts Node mode **before** launching, so a regression cannot open
the developer's app. It checks discovery, tool forwarding, exclusive control,
outage refusal, and draining a large final response at shutdown.

This proves the helper launch/transport, not arbitrary macOS background input
or the user's reported session. No real CUA daemon, provider, user app, or
screen is controlled. Browser and VNC/VM transports are separate and unchanged
by this fix. The prompt prefers background window-targeted actions and asks
before escalating to foreground control; that is guidance, not an OS-level
background-input guarantee.

## Responsive desktop startup

`pnpm exec vitest run electron/cua-launch.test.mjs` checks the desktop CUA
startup boundary without native permissions or controlling a real app. Electron
and the CUA SDK are mocked; every subprocess is redirected to an inert Node
child in a disposable home. The checks cover responsive asynchronous launch,
the actual eight-second TERM-ignoring timeout, Stop cancellation, original
failure details, bounded permission-status output, and cancellation of stalled
or late embedded startup without publishing over or stopping a replacement.
The installed SDK receives the startup AbortSignal directly. Registered IPC
retry checks also prove concurrent requests share one stop/start sequence and
an explicit Stop/quit during cleanup prevents its delayed restart.

The Electron subprocess ratchet permits only the pre-existing cached boot-ID
read and Linux private-group lookup. Those synchronous ownership checks remain
outside this narrow change; the active macOS launch/status calls are asynchronous.

Reference: OpenClaw's [macOS host coordinator](https://github.com/openclaw/openclaw/blob/7e1b9a63cf64fa5e77b92a7f77e8fccba7b61812/apps/macos/Sources/OpenClaw/CuaDriverHostCoordinator.swift)
keeps the daemon owned by the desktop host, and its
[window action adapter](https://github.com/openclaw/openclaw/blob/7e1b9a63cf64fa5e77b92a7f77e8fccba7b61812/extensions/cua-computer/src/window-actions.ts)
distinguishes window delivery from full-desktop input. OMB retains its existing
CUA driver, permission broker, and human-control gate rather than importing
OpenClaw's application-specific gateway or unrestricted authorization policy.

## Windows local control

`pnpm build:cua:win && pnpm smoke:cua-win` on Windows x64 stages the pinned
0.28.2 executable and matching SDK, loads the packaged native-library bundle,
starts an embedded host, then proves its child exits after Stop. CI runs this
on a disposable Windows runner with telemetry disabled and a bounded timeout.
The smoke does not capture a screen or send input.

Packaging retains the original `cua-driver.exe` for the stdio MCP proxy and
derives `cua-driver-background.exe` for the embedded daemon. The pinned native
SDK owns process creation and has no `windowsHide` option. The derived copy
uses the Windows GUI subsystem, with identical executable sections and entry
point. Its obsolete upstream signature is removed, and its PE checksum is
recalculated; the upstream CLI remains byte-for-byte intact. The conversion
rejects unsupported architectures, truncated images, and non-trailing
certificate tables. This is a package build step, never an installed-file edit.
See Microsoft's [PE format reference](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format).

The smoke compares the complete derived image, checks via Windows
`AttachConsole` that the running daemon has **no console**, initializes MCP
through the original CLI, lists tool definitions, and stops the owned daemon.
The console probe runs in its own hidden PowerShell process and touches only
the smoke's child. It does not prove an entire NSIS install/update flow or
custom `CUA_DRIVER_PATH` executables. An explicit override remains untouched;
an incomplete installed package reports a missing-driver error rather than
silently falling back to the console binary.

`pnpm smoke:cua-win-lend`, which CI's Windows CUA job runs after that smoke,
copies Electron under the installed app's name, so `app.isPackaged` is true,
and places the staged files where `electron-builder.yml` puts them. In
Electron's main process it runs `electron/cua.mjs`'s packaged start unchanged,
then a Cloud's first look at the PC through the lend path: the tool list, the
screen's size and the list of apps, over the proxy a lent screen starts with
the environment it gets. It sends no input. It prints computer control's mode,
the reason Windows gave when it did not start, and whether apps and screen
would be lent. On a pull request it first runs the base branch's `electron/`
the same way, so one run shows what the change does; only this branch's result
decides the job.

How Windows Security treats the real installer is the job of the Windows
Defender check (`.github/workflows/windows-defender-check.yml`), run by hand
or by the `defender-check` label on a pull request. On a fresh GitHub Windows
machine it builds the installer the way the release does, turns Defender's
protection on the way a home PC has it (GitHub's image turns most of it off and
excludes every drive), saves the installer like a browser download
(`Zone.Identifier`, `ZoneId=3`), installs it silently, opens the app for two
minutes and presses Start screen control through the app's DevTools port. Its
summary says what Defender found (threat detections and Operational events
1116, 1117, 1006–1008 and 1015), whether `cua-driver-background.exe` runs, what
the app's log says about computer control and whether Start screen control
worked; the `defender-check` artifact holds the rest. It is Windows Server,
not Windows 10 or 11: SmartScreen's "Windows protected your PC" screen and
Smart App Control still need a person's PC.

### When a Cloud can't use this computer

The icon's menu says what the person's own Clouds can't use and why, with the
one fix ("Screen control isn't running on this PC" and Start screen control).
A Cloud's bot that needs the computer then calls `ask_for_computer`: one card
in the chat with a one-tap Turn on, the same ask in this app's own prompt, and
the request goes on by itself once the computer lends what was needed. Only on
the person's own Cloud, never a Team Cloud.

```sh
node --test electron/screen-status.node-test.mjs electron/computer-asks.node-test.mjs
pnpm exec vitest run electron/capabilities.test.mjs server/computer-asks.test.ts \
  server/host/computer-asks-host.test.ts shared/computer-ask.test.ts src/components/ComputerAskCard.test.ts
pnpm exec vitest run server/cloud-lending.e2e.test.ts -t "paused, the PC still hears"
```

The last one boots a real Cloud home and lends to it through the real
connector: paused, the computer hears the bot's ask, Turn on on the card
resumes it, and the bot's waiting call returns the computer.

`node --experimental-strip-types scripts/verify-windows-lend.ts --shots <dir>`
photographs the taskbar icon's menu as the real module builds it, the card in
the real chat (`computer-ask-preview.html`) and the PC's own screen-control
status, in a light and a dark look; `docs/verification/evidence/windows-lend/`
holds the current set.

### Foreground typing and menu clicks

The bundled Windows driver (0.28.2) sends a foreground `type_text` as one burst
of key packets, which Windows 11 Notepad scrambles, and answers a click that
picks a menu item with `foreground_unavailable` after the click worked. With a
driver older than 0.35.0, OpenMausBot types such text one character at a time
and tells the bot that the click was sent:

```sh
node --test electron/paced-typing.node-test.mjs electron/shared-computer-access.node-test.mjs
pnpm exec vitest run server/local-computer-proxy.test.ts server/mcp-bridge.test.ts \
  server/local-computer-guidance.test.ts server/unconfirmed-click.test.ts \
  server/lent-screen-guidance.test.ts
```

A fake driver scrambles a burst the way the report showed (" Zeile Drei"
became " iiiiiiiiii"); the proxy test runs the real local proxy against it, and
the shared-access test the lent-screen path. No Windows app is driven. A
driver of 0.35.0 or later types one character at a time itself, and these
calls then reach it unchanged.

The portable conversion checks use synthetic inert PE data:

```sh
pnpm exec vitest run scripts/cua-windows-background.test.mjs \
  electron/cua-windows-isolation.test.mjs electron/cua-launch.test.mjs
```

`pnpm exec vitest run electron/cua-windows-isolation.test.mjs` exercises the
Windows branch with a disposable directory and mocked SDK: private embedded
startup, failed host, cancellation, replacement isolation, shutdown,
and development binary discovery. It refuses macOS permission imports and any
unowned daemon launch or foreign-pipe probe. macOS keeps its existing fallback.

Release packaging calls `build:cua:win` automatically. This proves startup and
transport ownership, not arbitrary Windows input, elevated/UAC screens, or
background focus behavior; those still require a disposable interactive
Windows desktop acceptance test.

## Separate native focus issue

CUA's [background contract](https://cua.ai/docs/concepts/the-no-foreground-contract)
is background-first, with explicit foreground escalation for unsupported actions;
foreground interruption is not the expected outcome of a background call.
The bundled 0.22.1 already defaults to background delivery. The issue is not
fixed by adding that option or changing VNC.

As checked on 2026-09-11, upstream [issue #3331](https://github.com/trycua/cua/issues/3331)
and draft [PR #3530](https://github.com/trycua/cua/pull/3530) describe an additional
macOS focus problem. Even the 0.26.1 release still has the click activation path
that the draft removes. The draft's native focus-preservation evidence is pending.
Neither the helper regression nor a dependency bump establishes that this native
problem is solved. Do not label this patch a universal no-focus fix.

Qualify a future driver change against disposable target and foreground-sentinel
apps on an unlocked Mac. Check focus throughout the action, not only afterward:
AX click, pixel click, typing, scroll, covered windows, other Spaces, and actual
user takeover. Keep permissions and the host control gate enabled. Repeat through
the packaged embedded daemon, including signing and supported Mac architectures.
Do not use the operator's OMB data or authenticated browser profiles as fixtures.
