# Bring your own macOS worker

OpenMausBot keeps its control plane on one Mac and connects a bot to a macOS
machine you already run — a guest VM on the same Apple silicon Mac, or a
second physical Mac. It does not create the guest, manage a hypervisor, store
SSH credentials, open a TCP listener, mount the control plane's workspace, or
fall back to another computer when the worker fails.

A macOS worker pairs with [a Windows worker](byo-windows.md) rather than
replacing it: workers are named independently and lease independently, so one
bot can hold a macOS desktop while another holds a Windows desktop.

## Why a guest and not this Mac

The `local` computer beta drives the Mac OpenMausBot is running on. That Mac
is also yours — the bot shares your screen, your keyboard and your files. A
guest gives the bot its own login session, its own home directory and its own
Accessibility grants, and it can be rebuilt from scratch when something goes
wrong.

Confirm that the current Apple software licence and your hypervisor permit the
guest you plan to run. This guide describes the technical boundary; it does
not grant virtualization rights.

## Before you start

- **Apple silicon.** macOS guests use Virtualization.framework; an Intel Mac
  cannot host one.
- **Disk.** Budget 80–100 GB: a restore image is roughly 16 GB (deletable
  after install) plus the guest's own disk.
- **A hypervisor.** [`tart`](https://tart.run) is the easiest to keep
  reproducible — it is CLI-driven, pulls prebuilt Apple silicon images, and
  `tart ip` gives you an address to put in your SSH config. UTM works too if
  you would rather click through the install.

## Create the guest

```bash
brew install cirruslabs/cli/tart
# Resolve and review an immutable registry digest first; never automate `latest`.
tart clone 'ghcr.io/cirruslabs/macos-sequoia-base@sha256:<APPROVED_DIGEST>' omb-worker
tart set omb-worker --cpu 4 --memory 8192 --disk-size 80
tart run omb-worker
```

Then, inside the guest:

1. Create a **dedicated standard (non-administrator) account** for the worker.
   Readiness refuses an account in the `admin` group: an administrator could
   rewrite the very base policy that bounds it, so installing the tools as an
   admin does not make that account an eligible worker.
2. Log in as the worker account and turn on **Users & Groups → automatic
   login** for it. An Aqua session must exist at all times; readiness checks
   that the worker account owns `/dev/console`.
3. Turn **off** screen lock and sleep (Lock Screen → *Require password …
   Never*, *Turn display off … Never*). A locked screen reads as not ready.
4. Turn on **General → Sharing → Remote Login** for that account only.

On the control-plane Mac, add the guest to your SSH config with key-only
authentication and confirm it works before going further:

```bash
ssh omb-worker true
```

OpenMausBot stores the alias with the worker's platform, display name, pinned
driver and policy digests, and optional browser/IDE paths. SSH credentials stay
entirely in the operator-owned SSH configuration.

## Install the tools

Inside the guest, as the worker account:

```bash
cua-driver --version                  # must print exactly 0.20.0
node --version                        # 24 or newer
openmausbot-worker-companion --version
```

Install the pinned CUA Driver release with the official instructions — do not
use an unreviewed wrapper or an ambient alternate binary. Build the companion
from the exact OpenMausBot source commit on the control-plane Mac with
`pnpm build:worker-companion`, copy only its `package.json` and `dist/` into a
private directory owned by the worker account, install its dependencies there
(`npm install --omit=dev`), and put its `openmausbot-worker-companion` bin on
that account's `PATH`.

The driver listens on a unix socket at `~/.openmausbot/run/cua.sock`. Both the
socket and its directory must be owned by the worker account and private to
it; readiness refuses a socket it cannot read and write.

## Grant Accessibility and Screen Recording

This is the one step nobody can script for you. macOS grants both permissions
**per binary**, System Integrity Protection prevents writing the permission
database, and replacing the driver binary silently revokes them.

In the guest, open **System Settings → Privacy & Security** and add the CUA
Driver binary under both **Accessibility** and **Screen Recording**. Then
confirm the driver itself sees them:

```bash
cua-driver call check_permissions '{"prompt":false}' \
  --socket "$HOME/.openmausbot/run/cua.sock"
```

It must print structured JSON with `accessibility: true`,
`screen_recording: true`, and `source.attribution: "driver-daemon"`. The
attribution matters: a standalone SDK check may show the launching terminal's
grant even when the daemon itself cannot control or capture the screen.

Readiness re-reads this on every poll rather than trusting that you did it
once, so a driver upgrade that drops the grants surfaces as
`worker_accessibility_denied` instead of as mysterious failures mid-task.

## Pin the base policy

Copy [`macos-base-policy.yaml`](macos-base-policy.yaml) into the guest at
`~/Library/Application Support/OpenMausBot/macos-policy.yaml`, then record its
digest:

```bash
mkdir -p "$HOME/Library/Application Support/OpenMausBot" "$HOME/.openmausbot/run"
chmod 700 "$HOME/Library/Application Support/OpenMausBot" "$HOME/.openmausbot/run"
cp macos-base-policy.yaml "$HOME/Library/Application Support/OpenMausBot/macos-policy.yaml"
shasum -a 256 ~/Library/Application\ Support/OpenMausBot/macos-policy.yaml
```

Enter that digest in OpenMausBot when you add the worker. Until you do, the
worker stays *unconfigured*: without a pinned digest the driver's tool ceiling
would be whatever happens to be on the guest's disk.

Note that a matching file is not sufficient on its own. CUA loads its policy
once at daemon start, and an unset policy variable disables enforcement
entirely, so readiness requires the daemon to *report* the same digest it
finds on disk.

## Install the parked capability manifest

The base policy is the stable ceiling; a **capability manifest** is the
short-lived, per-task boundary that intersects it. Between tasks the guest
should hold the parked manifest. It grants only `check_permissions`; the base
policy constrains that tool to `prompt: false`, so it can prove daemon TCC
status but cannot raise a dialog, observe the desktop, or control it:

```bash
cp macos-parked-capabilities.yaml \
  ~/Library/Application\ Support/OpenMausBot/active-capabilities.yaml
shasum -a 256 ~/Library/Application\ Support/OpenMausBot/active-capabilities.yaml
```

Readiness requires the daemon to report a loaded capability manifest, so a
guest without one never becomes ready. With the parked manifest in place the
worker is reachable and provably bounded, and cannot observe or control the
desktop until a task capability is approved — the correct resting state.

CUA 0.20.0 requires a non-empty tool list and caps bounded lifetimes at 24
hours. The health read refreshes the idle timer. When the absolute lifetime
expires, OpenMausBot refreshes the parked daemon once through the fixed
companion only after both pinned parked digests still match; it never performs
that repair over an active task capability.

CUA Driver 0.20.0 has no macOS `autostart` command. Install one dedicated Aqua
LaunchAgent with the fixed label `com.openmausbot.cua-worker`; the companion
restarts exactly this label whenever it switches between parked and approved
capabilities. In the plist below, replace each `WORKER` and
`ABSOLUTE/PATH/TO` placeholder with the worker account's literal values:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.openmausbot.cua-worker</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProgramArguments</key><array>
    <string>/ABSOLUTE/PATH/TO/cua-driver</string><string>serve</string>
    <string>--socket</string><string>/Users/WORKER/.openmausbot/run/cua.sock</string>
    <string>--permission-mode</string><string>bounded</string>
    <string>--capability-manifest</string>
    <string>/Users/WORKER/Library/Application Support/OpenMausBot/active-capabilities.yaml</string>
    <string>--approve-capability-manifest</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>CUA_DRIVER_POLICY_FILE</key>
    <string>/Users/WORKER/Library/Application Support/OpenMausBot/macos-policy.yaml</string>
  </dict>
  <key>RunAtLoad</key><true/>
</dict></plist>
```

Save it as `~/Library/LaunchAgents/com.openmausbot.cua-worker.plist`, validate
and load it from the logged-in worker account, then prove the loaded digests:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.openmausbot.cua-worker.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.openmausbot.cua-worker.plist"
launchctl kickstart -k "gui/$(id -u)/com.openmausbot.cua-worker"
cua-driver status --socket "$HOME/.openmausbot/run/cua.sock"
```

Do not substitute a terminal-owned background process: on macOS the launch
responsibility chain determines which Accessibility and Screen Recording grants
the daemon receives. Do not reuse another IDE or CLI's service label; worker
capability restarts must remain isolated from those bridges.

## Add the worker

Add the worker through the admin config API, or while OpenMausBot is stopped in
the owner-only `~/.openmausbot/config.json` `workers` object, with:

- an id (lowercase, e.g. `mac-guest`)
- platform **macOS**
- the SSH alias
- the exact driver version `0.20.0`
- both the base-policy and parked-capability digests

Then assign a bot to it from that bot's Computer panel. Two workers may not
share one SSH alias — that would take two independent leases against a single
real desktop, and each would believe it held the screen exclusively.

## What the bot can and cannot do

One bot leases a macOS worker at a time; a second turn aimed at the same
desktop waits rather than interleaving real mouse and keyboard input. Work on
another worker, and on Linux Local VMs, continues in parallel.

Auto mode is unavailable on a worker. Every task is bounded by three
independent fences — the stable base policy, a short-lived CUA capability
manifest, and the task manifest — so there is nothing for auto mode to
approve on its own.

At a sign-in, password, MFA or CAPTCHA step the bot stops and asks you to
complete it on the visible screen.

## When it is not ready

Readiness reports the first thing that is actually wrong:

| Code | What to fix |
| --- | --- |
| `worker_offline` | SSH cannot reach the guest |
| `worker_driver_missing` / `worker_driver_wrong_version` | CUA Driver absent, off `PATH`, or not 0.20.0 |
| `worker_companion_missing` | the companion is not installed for the worker account |
| `worker_privileged_account` | the SSH account is in the `admin` group |
| `worker_no_interactive_session` | nobody is logged in at the guest's console |
| `worker_locked` | the guest's screen is locked |
| `worker_channel_missing` / `worker_channel_access_denied` | the driver socket is absent or not private to the worker account |
| `worker_policy_missing` / `worker_policy_mismatch` | the base policy is absent, unloaded, or not the pinned digest |
| `worker_permission_mode_mismatch` | CUA Driver is not running in bounded mode |
| `worker_permission_attribution_mismatch` | permission status did not come from the running CUA daemon |
| `worker_capability_missing` / `worker_capability_mismatch` | the parked or approved task capability is absent, unloaded, or has the wrong digest |
| `worker_accessibility_denied` / `worker_screen_recording_denied` | grant the permission to the driver binary in the guest |
| `worker_busy` | another turn holds this desktop |
