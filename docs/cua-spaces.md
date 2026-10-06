# Cua Spaces Local VM backend

An opt-in alternative to the managed container desktop. With
`localVm.backend: "cua-spaces"`, every Local VM target becomes a
[Cua Space](https://cua.ai/docs/spaces/quickstart) on this machine: a Linux
desktop in a container, or a macOS virtual machine (Lume, Apple silicon).

Cua Spaces is source-available (FSL-1.1-MIT) and is **never bundled**. The
person installs it (`curl -fsSL https://cua.ai/install.sh | sh` installs the
`cua` CLI and, on macOS, the Cua Spaces app that hosts its daemon).
OpenMausBot only calls that CLI.

## Configuration

```json
{
  "localVm": {
    "backend": "cua-spaces",
    "spacesOs": "linux",
    "mode": "per-bot",
    "maxInstances": 2
  }
}
```

- `backend` — `"container"` (default) or `"cua-spaces"`. Enabling Cua Spaces is
  refused (409) unless `cua` is installed and at least `MIN_CUA_VERSION`
  (0.2.0).
- `spacesOs` — default OS, `"linux"` (default) or `"macos"` (refused on hosts
  without Apple silicon).
- A bot's `vmOs` (`"linux" | "macos"`, absent = default) overrides the OS for
  that bot in shared and per-bot mode. Pool seats are shared by every bot and
  always use the default OS.
- `mode`, `maxInstances` and `idleTimeoutMinutes` keep their container
  meaning. Changing `backend` or `spacesOs` is fenced like a mode change: it is
  refused while a Local VM turn or setup action runs, and the previous
  backend's desktops are left in place.

Settings → Computers always shows the Cua Spaces toggle; without a usable
install it is disabled and links to the quickstart.

The bot's Computer panel offers Space Create, Start and (in Advanced mode)
Delete in shared and per-bot mode, but not for pool seats. Settings → Computers
offers the Shared Space lifecycle card only in shared mode. Pool seats are
assigned by the server; the bot's Access settings explains that they use the
default OS instead of offering an ineffective per-bot OS selector. Container
setup and lifecycle gates are unchanged.


## How it maps

| Concern | Container backend | Cua Spaces backend |
| --- | --- | --- |
| Identity | `LocalVmTarget` (`shared`, `bot:<sha>`, `pool:N`) | Same target plus `space: { name, os, title }`; key gains `:cua-<os>` |
| Space name | — | `<container name>-<os>`, e.g. `openmausbot-computer-linux`, `openmausbot-computer-<16 hex>-macos` (stable; never renamed) |
| Display name in Cua Spaces | — | `OpenMausBot: <bot name> (Linux\|macOS)`, `OpenMausBot: shared (…)`, `OpenMausBot: pool N (…)` via `cua spaces add local:N --name …` |
| Image | pinned OMB derivative of `trycua/xfce-cua` | `ghcr.io/trycua/linux:24.04`, `ghcr.io/trycua/macos:26-slim` |
| Create / start / stop / delete | runtime CLI | `cua spaces create IMAGE --on local --name N --json`, `cua spaces start\|stop local:N --json`, `cua sb rm local:N --force --json` then `cua spaces rm local:N --json` |
| Status | runtime inspect + driver health | `cua sb ls --local --json --embedded` (one listing per 1.5 s burst) |
| Agent tools | `cua-driver mcp` via `container exec` | `cua mcp --sandbox local:N --permissions computer:all` |
| Preview frames | driver screenshot via exec | `cua sb screenshot local:N -o FILE` |
| `vm_exec` | `container exec … timeout sh -lc` | `cua sb exec local:N` (GNU `timeout` inside Linux; host-side limit on macOS) |
| `attach_file` | host bind mount | `cua sb cp` of the one file into a private staging folder |
| Human view/control | noVNC in the app's live-desktop window | Cua's HTML5 viewer in the same app window (`cua sb view --no-open --json`) |

`server/local-vm-backend.ts` is the only dispatcher: it picks the backend from
`target.space`, so leases, idle timers, wake rules, routes and the turn attach
never branch on the backend. The adapter is `server/cua-spaces-computer.ts`;
the agent bridge is `server/cua-spaces-mcp.ts` (shared `mcp-bridge.ts`: ping,
provider-safe schemas, and the take-control gate).

`computer:all` exposes the computer, file and shell tools of that one Space
only. Space lifecycle, other Spaces and skills are out of reach; Cua fails
closed on unknown permissions.

## Ownership

A predictable Space name is not proof of ownership. OpenMausBot manages a
Space only when this app data directory has its ownership receipt at
`cua-space-ownership/<sha256 sandbox-name>.json` (`{ name, addedAt? }`).
The private receipt directory is `0700`, its atomically written files are
`0600`, and a receipt is written **before** calling create so a partially
created Space can still be recovered. When Cua returns `added_at`, that
registry identity is recorded too; a different identity under the same name
does not belong to the app.

Without a matching receipt, an existing Space remains unmanaged: status keeps
its actual running/stopped state, sets `ready: false`, and explains the name
collision in `problem`. The app does not start, stop, delete or relabel it.
Its lifecycle controls are not offered. Receipts are removed only after both
sandbox deletion and registration removal succeed. A second app data
directory cannot adopt another directory's Space just by sharing its name.


## Display names

The sandbox name is derived from the bot's id so it never changes. What Cua
Spaces shows is the registry display name, which follows the bot: it is set
right after a create, again for every existing Space when the app starts, and
whenever a bot's name changes by any path (Settings, a profile proposal, the
Chief). Re-adding a registered Space with `cua spaces add local:N --name …`
updates only that label.

## Viewing and control

The Computer panel keeps rolling screenshots, as for the container backend.
Embedding Cua's viewer in the panel is not possible without proxying it: the
viewer page sends `frame-ancestors 'none'` and talks Connect-RPC plus a media
WebSocket to the Space. It opens instead in the app's own live-desktop window
(the sandboxed `desktop-viewer:open` window the noVNC desktops use), where it
renders the H.264 stream through WebCodecs.

- **Open live desktop** — `POST /api/bots/:id/local-computer/viewer` returns a
  one-hour link with keyboard, mouse and clipboard. It never pauses the bot:
  the person and the bot use the Space together.
- **Take control** — takes the existing computer-control hold first (the
  bridge gate then refuses the bot's tool calls), then opens the same window.
  Closing the window, or Hand back, releases it, as for every live desktop.

Viewer links carry a bearer ticket for the Space, so the route answers
loopback callers (the desktop app) only, and hands on a link only when it
points at this machine: loopback (Linux Spaces) or a guest on the Mac's own
Virtualization NAT bridge (`bridge100`+, macOS Spaces). The Electron window
applies the same rule (`electron/desktop-viewer.cjs`). A macOS Space's
window needs Local Network access for OpenMausBot (System Settings → Privacy
& Security → Local Network). Phone control (`/local-computer/join`) is
container-only.

The macOS viewer page is served **inside the guest**, not from the app's
bundled noVNC page. The bot can control guest files/processes and therefore
the content at that viewer origin. Opening it grants that origin the same
viewer permissions as container noVNC: host clipboard read/sanitized write,
keyboard lock, pointer lock and fullscreen. Treat a bot-controlled guest
viewer as trusted content before opening it; Take control pauses tool input,
but does not make the guest page trustworthy. Permissions apply only to the
selected viewer origin; camera, microphone, screen capture, geolocation and
other privileged capabilities remain denied. The `bridge1xx` HTTP exception
is macOS-only, and must match a subnet on this Mac's actual bridge interface.


## Lifecycle notes

- Idle shutdown calls `cua spaces stop`: a container Space is suspended (memory
  kept), a macOS Space is stopped (disk kept). A turn wakes it with
  `cua spaces start` and waits up to 90 s (Linux) or 5 min (macOS boot).
- A turn may create a missing Space on its own, as it may recreate a missing
  container. The first macOS Space downloads ~27 GB; later ones clone it.
- A failed create keeps Cua's own message as the Space's `problem` (for
  example macOS's Local Network permission for the Cua Spaces app) until a
  create succeeds.
- Human Create/Start readiness polling is bounded after the lifecycle request
  returns: 90 s for Linux Spaces, 5 min for macOS Spaces (containers keep
  60 s). On timeout, the UI retains the last status and Cua's `problem`,
  releases pending controls, and offers Start again for an owned, non-pool
  Space. Retrying does not delete/recreate the desktop.
- macOS `vm_exec` applies its watchdog inside the guest: at the deadline it
  terminates the command's process group, then force-kills it after a 5 s
  grace period. Exit 124 remains a structured
  `{ exitCode: 124, timedOut: true, stdout, stderr }` result.
- Guest attachment paths containing `:` are rejected with HTTP 400 before
  copying, with a request to rename the file. Cua treats `NAME:path` as a
  sandbox-qualified path; arbitrary guest paths must not select another
  Space.
- Deleting a bot in per-bot mode deletes both of its Spaces.
- Apple allows two macOS VMs at a time; Cua reports the error if a third is
  started.

## Platforms

| Where OpenMausBot runs | Cua CLI found at | Spaces | Live desktop |
| --- | --- | --- | --- |
| macOS, Apple silicon | PATH, `~/.local/bin`, or the Cua Spaces app bundle | Linux and macOS | App window (macOS Spaces need Local Network access for OpenMausBot) |
| macOS, Intel | same | Linux only (macOS is refused) | App window |
| Windows | PATH or `%LOCALAPPDATA%\Programs\cua\bin\cua.exe` (install.ps1), found without restarting the app | Linux only | App window |
| Linux desktop | PATH, `~/.local/bin` (or `/usr/local/bin` for root installs) | Linux only | App window |
| Headless server (`openmausbot serve`), browser or phone clients | the server's own install | as above for the server's OS | Screenshot previews only: viewer links are loopback-only, so Open live desktop and Take control are not offered remotely, and phone control is container-only |
| OMB Cloud home | — | Local VM is not offered | — |

Local paths never reach `cua` in a form it could misread: `cua sb cp` gets a
destination relative to its working folder, since a Windows drive path
(`C:\…`) looks like `NAME:path`. Only macOS was tested live (2026-10-03);
the Windows and Linux rows follow Cua's installers and CLI help.

## Verification

```sh
pnpm exec vitest run server/cua-spaces-api.test.ts server/cua-spaces-computer.test.ts server/testing/fakes-self-contained.test.ts server/system-prompt.test.ts src/lib/local-vm-readiness.test.ts src/components/LocalComputerSection.test.ts src/components/LocalComputerSection.cua.test.ts src/components/ComputerPanel.simple.test.ts src/components/bot-settings/AccessSection.test.ts
node --test electron/desktop-viewer.node-test.mjs
```

For isolated CLI fixtures, `OMB_CUA_CLI` selects an absolute executable path.
An invalid/non-executable override reports a missing CLI without falling
back to PATH. Always pair a fake executable with a temporary `HOME` and
`OMB_DATA_DIR`; never point API tests at the user's Spaces or live app data.

The live recipe is in [verification/cua-spaces.md](verification/cua-spaces.md).
