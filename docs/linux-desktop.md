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
- An explicit local-computer control beta on GNOME/Xorg and guarded GNOME/Wayland with bundled Cua Driver
  0.19.3 and an approval-capable Claude or ACP provider.

The local preview does **not** give the bot control of this computer by itself. Local control is a separate,
off-by-default beta. Automatic Wayland helper installation, Linux dictation, and ARM64 remain unavailable and
fail closed; follow their progress in [issue #29](https://github.com/milind-soni/OpenMausBot/issues/29). Bundled
CUA supply-chain work is tracked in [issue #113](https://github.com/milind-soni/OpenMausBot/issues/113). Xorg is tracked in
[issue #79](https://github.com/milind-soni/OpenMausBot/issues/79), and guarded GNOME/Wayland support in
[issue #109](https://github.com/milind-soni/OpenMausBot/issues/109).

## Download packages

Choose one Ubuntu 24.04 x86_64 package from the latest release:

- [Debian package (`OpenMausBot-amd64.deb`)](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/OpenMausBot-amd64.deb) — recommended; APT installs its desktop dependencies.
- [Portable AppImage (`OpenMausBot.AppImage`)](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/OpenMausBot.AppImage) — does not install system files.
- [SHA-256 checksums](https://github.com/milind-soni/openmausbot-releases/releases/latest/download/SHA256SUMS-ubuntu-x64.txt)

Versioned packages and previous releases remain available on the
[releases page](https://github.com/milind-soni/openmausbot-releases/releases).

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

Local computer control is a separate opt-in. On Wayland, OpenMausBot recognizes only GNOME/Mutter and requires
the certified Cua health report to pass AT-SPI, portal capture, and the portal/libei input backend with verified
WinRects target activation. Other Wayland compositors remain unavailable. XWayland's `DISPLAY` never bypasses
these checks.

## Enable local control

Installed `.deb` and AppImage builds include the certified **Cua Driver 0.19.3** CLI and cursor-theme sidecar.
You do not need to install Cua separately for GNOME/Xorg. OpenMausBot starts its own private daemon only after
you enable the beta; it never starts, updates, or stops a global Cua daemon.

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
requires one of those modes consistently across the reviewed resource tree. Because `0775` is correctly rejected by
the normal executable-path policy, AppImage launch always copies only the two pinned files into a fresh private
`0700` temporary directory, verifies both hashes after the copy, executes from there, and removes that directory on
quit. DEB and unpacked builds keep their package path at `0755` and execute directly. This exception does not relax
validation for an explicit override, `PATH`, or any other group-writable location.

An explicit absolute `CUA_DRIVER_PATH` remains an advanced override for development and incident response. A
packaged app otherwise uses only its bundled driver and fails closed if it is missing, unsafe, changed, or
incompatible—it never silently executes `~/.local/bin/cua-driver` or a PATH candidate. Source/dev runs retain the
validated user-local discovery described by the [official Cua installation guide](https://cua.ai/docs/how-to-guides/driver/install).

GNOME/Wayland still needs the privileged WinRects v8 Shell helper. OpenMausBot does not install or enable a Shell
extension silently. If it is not already active, download the same pinned archive, verify it, extract only the helper,
review its installer, and run it explicitly:

```sh
version="0.19.3"
asset="cua-driver-rs-${version}-linux-x86_64-binary.tar.gz"
download_dir="$(mktemp -d)"
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$download_dir/$asset" \
  "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/$asset"
printf '%s  %s\n' \
  '3db9d4257d84bacaf7eb104d225f85613ce67edbb20d6eeb83c1384b6d8a5b10' \
  "$download_dir/$asset" | sha256sum --check --strict
tar --extract --gzip --no-same-owner --no-same-permissions \
  --file "$download_dir/$asset" --directory "$download_dir" wayland-helper
sed -n '1,240p' "$download_dir/wayland-helper/install.sh"
"$download_dir/wayland-helper/install.sh"
```

Sign out and back in once, then verify that GNOME loaded exactly the expected helper:

```sh
gnome-extensions info winrects@cua
```

The output must include `Version: 8`, `Enabled: Yes`, and `State: ACTIVE`. OpenMausBot never installs or enables
this GNOME extension silently. The helper exposes window identity, geometry, capture, cursor, and verified target
activation to Cua; foreground pointer or keyboard delivery remains scoped by GNOME's Remote Desktop portal and
may ask for session consent.

Then:

1. Open a bot's **Computer** panel.
2. In **Local control**, choose **Enable local control (Beta)** and review the warning.
3. Wait until the card shows **Ready**, including the verified driver path and version.
4. Select **This computer** for that bot. Enabling the global capability never assigns a bot automatically.

Linux **Auto** never falls back to the user's desktop. **This computer** is available only when the current
provider advertises an interactive approval channel. Claude `bypassPermissions`, ACP full-auto, Codex's current
app-server adapter, non-GNOME/headless sessions, missing diagnostics, and stale/crashed runtimes fail closed.

OpenMausBot starts one private embedded daemon with a private socket for its own app generation. It never touches
Cua's default/global daemon. On GNOME/Wayland, the app also rechecks the prompt-free health contract while the
runtime is active and revokes readiness if the helper or backend disappears. Disabling local control or quitting
stops the owned daemon and active proxies.

The driver uses Cua's `standard` permission mode. Cua routine actions are promptless at the driver layer, while
OpenMausBot requires its own **Allow** or **Deny** decision before every local action. Bot Auto mode, persistent
**Always allow** grants, and cloud-computer approvals cannot authorize the local desktop in this beta.

Cua Driver has content-free telemetry and an update check enabled by default. OpenMausBot disables both for every
Cua process it owns and does not change any separately installed Cua preferences. Driver updates arrive only with an
OpenMausBot application release; rolling back the app rolls back the paired driver. Review the upstream behavior in
the [official telemetry documentation](https://cua.ai/docs/reference/cua-driver/telemetry).

## Validate a package change

```sh
pnpm typecheck
pnpm test
pnpm check:electron
pnpm build:cua:linux          # networked, checksum-pinned staging
pnpm package:linux:offline    # CUA staging is offline; builder caches must already be available
node scripts/verify-linux-package.mjs
pnpm smoke:linux-package
```

The verifier checks `.deb` metadata, desktop identity, the exact Cua resource tree and provenance, SquashFS/DEB
directory modes, runtime path policy, and matching binary hashes across all artifacts. The smoke test launches the
unpacked production app and AppImage without `--no-sandbox` and validates the renderer/preload, embedded health
endpoint, packaged bundled-driver resolution, strict MCP environment, and process cleanup. It starts the real
bundled driver under Xvfb/D-Bus to prove packaged launch, private-daemon readiness, and cleanup, then uses a fake
explicit override to prove diagnostics,
private-daemon readiness, crash invalidation, explicit retry, and clean shutdown in separate Xorg and simulated
GNOME/Wayland contract lanes. The Wayland lane also requires the opt-in environment and certified health report.
Its wrapper isolates the temporary D-Bus/AT-SPI runtime so it cannot replace the live desktop session's
accessibility socket. Real inspection, input actions, and portal behavior still require evidence from real GNOME
Xorg and GNOME Wayland sessions; the CI lanes are not a substitute for that evidence.

## Troubleshooting

### An agent CLI is missing

Run the CLI directly in a terminal, finish its sign-in flow, then restart OpenMausBot. If it lives outside the
common directories above, use `OMB_EXTRA_PATH` while testing and report the install location so it can be
considered for automatic discovery.

### A bot needs computer tools

Choose **Cloud box** and add a Box token in App Settings, or complete the local-control opt-in above on a supported
GNOME session. A missing driver/helper, unsupported compositor or provider keeps **This computer** disabled with
an explanation.

### Local control is not ready

The in-app card is the primary diagnostic because packaged builds do not add Cua Driver to `PATH`. For a DEB
installation, run the bundled executable directly in a terminal launched inside the same GNOME session:

```sh
echo "$XDG_SESSION_TYPE"  # x11 or wayland
driver=/opt/OpenMausBot/resources/cua-linux-x64/cua-driver
export CUA_DRIVER_RS_UPDATE_CHECK=false
export CUA_DRIVER_RS_TELEMETRY_ENABLED=false
"$driver" --version      # must be 0.19.3 for this beta
"$driver" doctor --json
```

For an AppImage, prefer the in-app diagnostic; its verified read-only mount path exists only while the app is
running. Maintainers testing an unpacked build can use
`release/linux-unpacked/resources/cua-linux-x64/cua-driver`.

On Wayland, also run:

```sh
echo "$XDG_CURRENT_DESKTOP"  # must include GNOME
gnome-extensions info winrects@cua
CUA_DRIVER_RS_UPDATE_CHECK=false \
CUA_DRIVER_RS_TELEMETRY_ENABLED=false \
CUA_DRIVER_RS_ENABLE_WAYLAND=1 \
  /opt/OpenMausBot/resources/cua-linux-x64/cua-driver doctor --json
```

If the helper is installed but not `ACTIVE`, sign out and back in once. If the app reports a portal error, confirm
that `xdg-desktop-portal` and `xdg-desktop-portal-gnome` are running in the user session. OpenMausBot's readiness
probe never opens a consent prompt; GNOME may prompt when the first approved foreground input action starts.

Repair any display, session bus, or AT-SPI diagnostic before choosing **Try again**. If the path shown in the app
is unexpected, close OpenMausBot and launch it with an absolute `CUA_DRIVER_PATH`. An invalid explicit override
fails without silently selecting another executable. For `unsafe-driver-permissions`, use the bounded
permission-hardening commands in **Enable local control**; do not make the driver executable or its
directories world-writable.

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
