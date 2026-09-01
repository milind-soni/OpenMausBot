# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime. For giving a bot the same kind
of Linux desktop on your own server instead of this machine, see [byo-vps.md](byo-vps.md).

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Composio connected apps and Box cloud computers.
- External documentation and OAuth links in the default browser.
- An explicit, view-only local screen preview on GNOME Xorg and GNOME Wayland. The Wayland path uses the
  native portal chooser and keeps the selected PipeWire stream open until the user stops sharing.
- Explicit opt-in local computer control on GNOME Xorg using the bundled, pinned Cua Driver without its
  decorative full-screen cursor overlay.
- A fail-closed local-control state on GNOME Wayland while its separate real-seat input-safety gate in issue #345
  is resolved.

The local preview does **not** give the bot control of this computer by itself. On Xorg, local control requires both
the global **Enable local control** choice and assigning a bot to **This computer**; every action still enters the
approval flow. On Wayland, local control is disabled and legacy opt-ins are cleared automatically. Automatic Wayland
helper installation, Linux dictation, and ARM64 remain unavailable and fail closed; follow their
progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29) and the safety hold in
[issue #345](https://github.com/milind-soni/OpenMausBot/issues/345). Bundled
CUA supply-chain work is tracked in [issue #113](https://github.com/milind-soni/OpenMausBot/issues/113). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`OpenMausBot-amd64.deb`)](https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot-amd64.deb) — recommended; APT installs its desktop dependencies.
- [Portable AppImage (`OpenMausBot.AppImage`)](https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot.AppImage) — does not install system files.
- [SHA-256 checksums](https://github.com/milind-soni/OpenMausBot/releases/latest/download/SHA256SUMS-ubuntu-x64.txt)

Versioned packages and previous releases remain available on the
[releases page](https://github.com/milind-soni/OpenMausBot/releases).

## Build packages

Requirements for building from source:

- Ubuntu 24.04 LTS x86_64
- Node.js 24 or newer
- pnpm 10.33.0 (Corepack can install the version declared by the project)

```sh
git clone https://github.com/milind-soni/OpenMausBot.git
cd OpenMausBot
corepack enable
pnpm install --frozen-lockfile
pnpm package:linux
```

The build creates:

- `release/OpenMausBot-<version>-amd64.deb`
- `release/OpenMausBot-<version>-x86_64.AppImage`

The AppImage uses a static runtime and does not require the legacy `libfuse2` package.

## Install and run

Install a downloaded Debian package with APT so its desktop dependencies are resolved:

```sh
sudo apt install ./OpenMausBot-amd64.deb
```

Then open **OpenMausBot** from the GNOME application launcher. To remove it:

```sh
sudo apt remove openmausbot
```

The portable AppImage does not install system files:

```sh
chmod +x release/OpenMausBot-*-x86_64.AppImage
./release/OpenMausBot-*-x86_64.AppImage
```

For a downloaded release AppImage, use `OpenMausBot.AppImage` in place of the versioned path above.

Application data remains local in `~/.openmausbot`. Electron browser data and window state use the normal XDG
configuration directory (`~/.config/openmausbot` unless the environment overrides it).

## Develop the desktop shell

Development mode uses three processes. Keep each command running in its own terminal:

```sh
pnpm dev:server
pnpm dev
pnpm dev:desktop
```

For a package-shaped build without creating `.deb` or AppImage artifacts:

```sh
pnpm package:linux:dir
./release/linux-unpacked/openmausbot
```

## Agent CLI discovery

Applications launched from GNOME do not inherit the same interactive shell `PATH` as a terminal. OpenMausBot
keeps the inherited path and adds existing common locations such as:

- `~/.local/bin`
- `~/.claude/local`
- `~/.volta/bin`
- `~/.bun/bin`
- `~/.asdf/shims`
- `~/.deno/bin`
- `~/.nvm/versions/node/*/bin`
- `/usr/local/bin`

It also probes the login shell in the background. If a CLI still is not detected, set an explicit additional
path before launching the app from a terminal and verify it there:

```sh
OMB_EXTRA_PATH=/your/custom/bin ./release/OpenMausBot-*-x86_64.AppImage
```

Restart OpenMausBot after installing or signing in to a CLI.

## Xorg and Wayland

The shell, chat, cloud computers, connected apps, and preview-only capture work in both GNOME session types.
The Wayland chooser/select/persistent-stream/cancel/end/retry lifecycle has been validated in a real Ubuntu
24.04 GNOME Wayland session. OpenMausBot detects Wayland before XWayland when both `WAYLAND_DISPLAY` and
`DISPLAY` exist, so capture cannot accidentally bypass portal-mediated behavior.

Open the Computer panel and use the separate **Preview this computer** card. Capture never starts when the app
or panel opens.

- **Xorg:** **Start preview** captures the primary monitor directly.
- **Wayland:** **Choose a screen** opens the GNOME portal chooser once. The selected stream stays open until
  you press **Stop preview**, close the panel, end sharing from GNOME, or quit the app.

Cancelling or ending Wayland sharing returns to a calm **Try again** state and never reopens the chooser
automatically. OpenMausBot does not capture screen audio, remember the selected monitor after restart, or
offer an **Open Settings** action on Linux.

Local computer control is independent from preview. It is available after explicit opt-in on Xorg and remains
fail-closed on Wayland. XWayland's `DISPLAY` never bypasses the Wayland safety gate.

## Enable local control

Installed `.deb` and AppImage builds include the certified **Cua Driver 0.19.3** CLI and cursor-theme sidecar.
On GNOME Xorg, open Settings, choose **Enable local control (Beta)**, wait for **Ready**, then explicitly assign a bot
to **This computer**. No driver download, terminal command, `chmod`, or daemon setup is required. The owned daemon
starts with `--no-overlay`, so Cua's decorative full-screen X11 cursor surface is never created. OpenMausBot also
uses Electron software rendering on Linux to avoid the reproduced NVIDIA/libGLES GPU-process failure that could
leave an invisible focused app window receiving input.

Cua actions use a private logical cursor. With the decorative overlay disabled, `move_cursor` does not move the
user's physical pointer; approved click and typing actions still target the requested window, while the user's own
mouse remains under their control.

On GNOME Wayland, **This computer** remains unavailable and an older persisted opt-in is reset to off with private
file permissions. Sign out and choose **Ubuntu on Xorg** from the login-screen session menu, or continue using Chat,
preview-only capture, Cloud, or Local VM. Wayland re-enablement requires its own real-seat evidence and will not be
controlled by an environment override.

The upstream release has no signature or GitHub artifact attestation and is not immutable, so the build uses an
explicit reviewed digest as its trust anchor:

- source commit: `a1672e7b11951275ecfba3384264d4530185d0db`;
- archive SHA-256: `3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10`;
- packaged driver SHA-256: `ed5844fadf07b9b72c4a3b3802e1c47233c166d66d6198608d5991f807aab4ac`;
- packaged cursor-theme SHA-256: `e589b2b7521bbfeaf9e2bfce668a38e80ed1b9790b1327b13d374fc331d8312a`.

Packaging verifies the exact archive size, checksum, member names/types/sizes, and inner hashes before extracting
only those two executables. The app performs no runtime driver download or self-update. Cua's MIT license, the
embedded Inter font's SIL OFL 1.1 notice, full dependency license texts, MPL source locations, and a CycloneDX
inventory ship beside the binary; the reviewed source records live in [`third_party/cua-driver`](../third_party/cua-driver/).
The reviewed native runtime adds roughly 11–13 MiB to a compressed Ubuntu artifact. The ELF
requires glibc 2.30 or newer plus the standard Ubuntu X11/XInput/xkbcommon libraries already present on the supported
Ubuntu 24.04 desktop; the package verifier executes the exact binary from every artifact layout.

AppImage's pinned SquashFS toolchain can emit root-owned directories as `0755` or `0775`; the package verifier
requires one of those modes consistently across the reviewed resource tree. Before execution, AppImage copies only
the pinned binaries into a private `0700` stage and verifies their hashes again. DEB upgrades repair their exact
package-owned path to `root:root 0755` automatically.

The packaged runtime remains outside ASAR for deterministic provenance and validation. In packaged builds neither a
`CUA_DRIVER_PATH` value nor an ambient PATH candidate can replace it; on Wayland neither can bypass the safety gate.

The Xorg runtime uses private sockets, standard permission mode, per-action OpenMausBot approvals,
telemetry/update-check suppression, strict driver identity, overlay-free startup, and lifecycle cleanup tests. Those
defenses remain necessary, but none substitutes for the real-seat acceptance evidence required to enable Wayland. Linux
**Auto** never routes to the user's desktop, and no Cloud or Local VM approval can authorize it.

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm build:cua:linux          # networked, checksum-pinned staging
dbus-run-session -- xvfb-run -a pnpm smoke:cua-x11-input
pnpm package:linux:offline    # CUA staging is offline; builder caches must already be available
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks `.deb` metadata, desktop identity, the exact dormant Cua resource tree and provenance,
SquashFS/DEB directory modes, runtime path policy, and matching binary hashes across all artifacts. The local smoke
launches the unpacked app and AppImage without `--no-sandbox`; CI first reproduces a `0.1.7` in-place DEB upgrade and
then runs the same smoke against `/opt/OpenMausBot/openmausbot`. These lanes prove the embedded server and UI are
usable while an optional Composio broker stalls, verify that an old local-control opt-in is cleared, and assert that
no Cua executable starts on Xorg or simulated Wayland. Low-level runtime tests retain the future private-daemon
contract without activating it in a packaged app. Only a real-seat acceptance matrix can authorize re-enablement.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud box** and add a Box token in App Settings, or use Local VM. Linux **This computer** remains disabled
on Wayland. On Xorg, enable it from the **Local control** card first.

### Local control is not ready

On Xorg, press **Try again** and use the reason shown in the card. The bundled package requires no manual driver
installation or `chmod`; an upgraded DEB repairs its exact package-owned directory modes automatically. On Wayland,
the card directs you to Ubuntu on Xorg and intentionally offers no enable button.

### Screen preview does not start

On Xorg, confirm the session has an active display with `echo "$XDG_SESSION_TYPE"`; it should print `x11`.
On Wayland, confirm `xdg-desktop-portal` and the GNOME portal backend are running, then click **Try again** to
open a new chooser. Cancelling or stopping sharing never causes an automatic second prompt.

### The AppImage does not start

Confirm the executable bit and architecture:

```sh
chmod +x OpenMausBot-*-x86_64.AppImage
file OpenMausBot-*-x86_64.AppImage
```

Run it from a terminal once to collect the startup output. Do not install `libfuse2` just for this AppImage; the
package is built with the static runtime.
