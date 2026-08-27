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

Apple's software licence allows up to two macOS guests on one Apple silicon
host, so a single worker guest leaves headroom.

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
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest omb-worker
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

OpenMausBot stores only that alias.

## Install the tools

Inside the guest, as the worker account:

```bash
cua-driver --version                  # must print exactly 0.20.0
node --version                        # 24 or newer
openmausbot-worker-companion --version
```

Install the pinned CUA Driver release with the official instructions — do not
use an unreviewed wrapper or an ambient alternate binary. Build the companion
from the exact OpenMausBot source commit on the control-plane Mac, copy only
its `package.json` and `dist/` into a private directory owned by the worker
account, and put its `openmausbot-worker-companion` bin on that account's
`PATH`.

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
openmausbot-worker-companion --permissions
```

It prints `{"accessibility":true,"screenRecording":true}` when both are live.

Readiness re-reads this on every poll rather than trusting that you did it
once, so a driver upgrade that drops the grants surfaces as
`worker_accessibility_denied` instead of as mysterious failures mid-task.

## Pin the base policy

Copy [`macos-base-policy.yaml`](macos-base-policy.yaml) into the guest at
`~/Library/Application Support/OpenMausBot/macos-policy.yaml`, then record its
digest:

```bash
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
should hold the parked manifest, which grants no tools at all:

```bash
cp macos-parked-capabilities.yaml \
  ~/Library/Application\ Support/OpenMausBot/active-capabilities.yaml
```

Readiness requires the daemon to report a loaded capability manifest, so a
guest without one never becomes ready. With the parked manifest in place the
worker is reachable and provably bounded, and can do nothing until a task
capability is approved — the correct resting state.

## Add the worker

In OpenMausBot, open **Settings → Workers**, add a worker with:

- an id (lowercase, e.g. `mac-guest`)
- platform **macOS**
- the SSH alias
- the base-policy digest

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
| `worker_accessibility_denied` / `worker_screen_recording_denied` | grant the permission to the driver binary in the guest |
| `worker_busy` | another turn holds this desktop |
