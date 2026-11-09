# Ubuntu Desktop

OpenMausBot has an Ubuntu 24.04 LTS x86_64 desktop beta. The Electron package embeds the harness server, so
installed builds do not require Node, pnpm, Swift, or a terminal at runtime. For giving a bot the same kind
of Linux desktop on your own server instead of this machine, see [byo-vps.md](byo-vps.md).

## What works

- The native Electron window and embedded OpenMausBot server on GNOME Xorg and GNOME Wayland.
- Local Claude, Codex, Grok, Gemini, and other configured agent CLIs.
- Chat, streaming turns, approvals, bot-to-bot communication, and local data storage.
- Composio connected apps and Boat cloud computers.
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
helper installation, native on-device dictation, and ARM64 remain unavailable and fail closed; follow their
progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29) and the safety hold in
[issue #345](https://github.com/milind-soni/OpenMausBot/issues/345). Bundled
CUA supply-chain work is tracked in [issue #113](https://github.com/milind-soni/OpenMausBot/issues/113). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`OpenMausBot-amd64.deb`)](https://github.com/milind-soni/OpenMausBot/releases/latest/download/OpenMausBot-amd64.deb) — recommended; APT installs its desktop dependencies and configures the bundled bot browser's sandbox.
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

### Arch Linux and EndeavourOS

Arch-based distributions can run the portable AppImage or install a native `.pacman` package.

#### Native pacman package
Build the pacman package from source:

```sh
pnpm package:arch
sudo pacman -U release/OpenMausBot-<version>-x64.pacman
```

Replace `<version>` with the built version (for example, `0.1.149`). Then launch `openmausbot` from the application launcher or command line.

#### Portable AppImage
A minimal Arch install lacks the FUSE helper and some desktop libraries the AppImage needs, so install them first:

```sh
sudo pacman -S --needed fuse3 gtk3 nss alsa-lib libcups mesa
chmod +x OpenMausBot.AppImage
./OpenMausBot.AppImage
```

A full desktop install (for example EndeavourOS with KDE or GNOME) usually has all of these already, and
`--needed` skips the ones that are present. This was checked with the v0.1.138 AppImage on a current Arch
Linux image (fuse3 3.18, gtk3 3.24, mesa 26.2): the app opens to the welcome screen.

### Updating

The app checks for updates in the background and downloads them by itself. Nothing restarts until you click
**Restart to update**.

- **Debian package.** The click asks for your password once, in the system's own prompt, installs the update with
  `apt-get` (so new dependencies are resolved) and reopens OpenMausBot. The downloaded file is copied to a
  root-only folder and checked against the checksum in the update feed first; a file that does not match is
  refused and nothing is installed. Closing the prompt leaves the update ready to try again. If the session cannot
  show a prompt (SSH, no desktop, no `pkexec`), the app falls back to copying the `sudo apt-get install` command
  and opening a terminal, and says why. Set `OMB_UPDATE_INSTALL=terminal` to always use the terminal.
- **AppImage.** The update replaces the AppImage when you restart; no password is needed.
- **rpm and pacman packages** still use the terminal hand-off.

### Bundled bot browser on Ubuntu 24.04

The desktop packages include the browser engine and browser runtime; no separate browser download is needed.
Use the **`.deb` package** for browser-ready installation on Ubuntu 24.04. Its installer secures the browser's
package-owned files and loads an AppArmor rule for that exact executable. The browser sandbox stays enabled,
and the machine-wide user-namespace restriction is unchanged. Upgrades refresh the same rule; uninstalling
the package removes it. Enabling a bot's browser and approving its actions remain explicit choices.

An AppImage is portable and cannot install privileged system policy. On hosts restricting unprivileged
user namespaces, its bundled browser can still report `No usable sandbox`. Install the `.deb` instead;
do not add `--no-sandbox`, disable AppArmor globally, or allowlist arbitrary executables under your home
directory. See [Chromium's explanation of the Ubuntu restriction](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

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

Installed `.deb` and AppImage builds include the certified **Cua Driver 0.41.3** CLI and cursor-theme sidecar.
On GNOME Xorg, open Settings, choose **Enable local control (Beta)**, wait for **Ready**, then explicitly assign a bot
to **This computer**. No driver download, terminal command, `chmod`, or daemon setup is required. The owned daemon
starts with `--no-overlay`, so Cua's decorative full-screen X11 cursor surface is never created. OpenMausBot also
uses Electron software rendering when the NVIDIA driver is loaded, to avoid the reproduced NVIDIA/libGLES
GPU-process failure that could leave an invisible focused app window receiving input. Other GPUs keep hardware
acceleration, because software rendering costs about a CPU core while the window animates. Set `OMB_LINUX_GPU=off`
to force software rendering or `OMB_LINUX_GPU=on` to force the GPU.

Cua actions use a private logical cursor. With the decorative overlay disabled, `move_cursor` does not move the
user's physical pointer; approved click and typing actions still target the requested window, while the user's own
mouse remains under their control.

On GNOME Wayland, **This computer** remains unavailable and an older persisted opt-in is reset to off with private
file permissions. Sign out and choose **Ubuntu on Xorg** from the login-screen session menu, or continue using Chat,
preview-only capture, Cloud, or Local VM. Wayland re-enablement requires its own real-seat evidence and will not be
controlled by an environment override.

Upstream release assets are mutable, so the build uses an explicit reviewed digest as its trust anchor (the release's
own `checksums.txt` and Sigstore bundles were checked when the digest was reviewed, but the build does not depend on them):

- source commit: `bd0e299c67dec6397b3d41a259452b2ea13a1cd5`;
- archive SHA-256: `a00a7bc4a648adbcbc93bfbf5a058daf71ce8838ee172e33b197aaf649ecee14`;
- packaged driver SHA-256: `83030028e7c9e3f4d753b3b27025135d44eb8d52f562cce0aaaf95777bc1b41f`;
- packaged cursor-theme SHA-256: `d39efb960d207e7328d7a9dd48e3b6565f74be073f9c2ca8dcba86a4d0f28312`.

Packaging verifies the exact archive size, checksum, member names/types/sizes, and inner hashes before extracting
only those two executables. The app performs no runtime driver download or self-update. Cua's MIT license, the
embedded Inter font's SIL OFL 1.1 notice, full dependency license texts, MPL source locations, and a CycloneDX
inventory ship beside the binary; the reviewed source records live in [`third_party/cua-driver`](../third_party/cua-driver/).
The reviewed native runtime adds roughly 14–21 MiB to a compressed Ubuntu artifact. The ELF
requires glibc 2.30 or newer plus the standard Ubuntu X11/XInput/xkbcommon libraries already present on the supported
Ubuntu 24.04 desktop; the package verifier executes the exact binary from every artifact layout.

AppImage's pinned SquashFS toolchain can emit root-owned directories as `0755` or `0775`; the package verifier
requires one of those modes consistently across the reviewed resource tree. Before execution, AppImage copies only
the pinned binaries into a private `0700` stage and verifies their hashes again. DEB upgrades repair their exact
package-owned path to `root:root 0755` automatically.

The packaged runtime remains outside ASAR for deterministic provenance and validation. In packaged builds neither a
`CUA_DRIVER_PATH` value nor an ambient PATH candidate can replace it; on Wayland neither can bypass the safety gate.
The one exception is Omarchy's package-owned `/usr/bin/cua-driver`, described in
[Omarchy (Hyprland, experimental)](#omarchy-hyprland-experimental).

The Xorg runtime uses private sockets, standard permission mode, per-action OpenMausBot approvals,
telemetry/update-check suppression, strict driver identity, overlay-free startup, and lifecycle cleanup tests. Those
defenses remain necessary, but none substitutes for the real-seat acceptance evidence required to enable Wayland. Linux
**Auto** never routes to the user's desktop, and no Cloud or Local VM approval can authorize it.

## Omarchy (Hyprland, experimental)

[Omarchy](https://omarchy.org) is Arch Linux with the Hyprland compositor. **This computer** works there only with
Cua's Hyprland plugin turned on. The plugin gives bots two seats of their own inside Hyprland (`Cua-Agent` and
`Cua-Agent-2`), so the compositor delivers their input to the target window without touching your pointer or
keyboard. Every other Wayland desktop (GNOME, KDE, Sway, or Hyprland without the plugin) keeps the safety gate above.
Support is experimental, like the plugin itself, which Omarchy leaves off by default and outside its normal installer.

1. Install and start the AppImage as in [Arch Linux and EndeavourOS](#arch-linux-and-endeavouros-appimage).
2. Install Omarchy's Cua packages, `cua-driver-bin` and `cua-hyprland-plugin`, and turn the plugin on as
   [Cua's Omarchy guide](https://cua.ai/docs/cua-sdk/guides/omarchy) describes. In Omarchy's Lua configuration that is
   `hl.config({plugin = {cua = {enabled = true}}})`; in a legacy configuration, `plugin:cua:enabled = true`. Then run
   `hyprctl reload`.
3. Check it: `hyprctl -j cua:status` should report `"state":"input_v3_candidate"`, `"configured":true`, and an input
   transport that is ready.
4. In OpenMausBot, open **Local control**, choose **Enable local control (Beta)**, wait for **Ready**, then assign a bot
   to **This computer**. Until the plugin is on, the card says how to turn it on, and **Try again** checks again.

How OpenMausBot decides:

- It treats the session as Hyprland only when `HYPRLAND_INSTANCE_SIGNATURE` is set and `XDG_CURRENT_DESKTOP` (or
  `XDG_SESSION_DESKTOP`) names Hyprland.
- It reads the plugin's status with the system `/usr/bin/hyprctl -j cua:status` (never a `hyprctl` from `PATH`), with a
  two-second limit, and treats anything other than a loaded, configured input build with a ready transport and a
  matching Hyprland ABI as off. It checks again every time local control starts, so a plugin left stale by a Hyprland
  update turns local control off instead of failing halfway.
- It prefers Omarchy's own driver. The plugin is built against the exact system Hyprland and ships beside the
  `cua-driver-bin` package, so that pair matches. OpenMausBot never bundles the plugin, because plugins break on
  Hyprland updates. This is the one exception to "only the bundled driver runs", and it is narrow:
  - the driver must be the fixed path `/usr/bin/cua-driver`, owned by root and not writable by anyone else;
  - `pacman -Qo` must say `cua-driver-bin` owns it (and owns its target, if it is a symlink);
  - the package version must name the binary that answers `--version`, in the bundled driver's minor line at or above
    the bundled patch release (0.41.3 or a later 0.41.x).

  That is the same root-owned package trust you already give the compositor. A user-installed copy or a `PATH`
  lookup never qualifies. If any check fails, OpenMausBot uses its bundled driver instead, started with
  `CUA_DRIVER_RS_ENABLE_WAYLAND=1`.

What works, and what doesn't:

- Native Wayland apps that bind the agent seats (GTK 3 and 4, Qt 6) take background clicks, typing, scrolls and drags.
  Qt 6 apps refuse background keys.
- Chromium, Chrome and Electron apps bind only your seat, so the driver refuses background input to them. Bots are told
  to open web pages in their own browser instead.
- XWayland windows, Unicode and IME input, multiple keyboard layouts, and modified pointer gestures are outside
  the plugin's input contract.
- A foreground action you approve moves your keyboard focus and pointer, and does not put them back.
- Every action still goes through OpenMausBot's approval flow, the same as on Xorg.

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

Choose **Cloud** (Boat) and add a Boat token in App Settings, or use Local VM. Linux **This computer** remains disabled
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

If it prints `No suitable fusermount binary found on the $PATH` or `Cannot mount AppImage, please check your FUSE
setup`, install the distribution's FUSE 3 package (`fuse3` on Ubuntu, Debian and Arch). If it then names a missing
`lib*.so` file, install the desktop libraries listed under
[Arch Linux and EndeavourOS](#arch-linux-and-endeavouros-appimage), or your distribution's packages for them.
