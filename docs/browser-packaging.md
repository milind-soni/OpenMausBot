# Browser-ready desktop packages

Desktop installers include the pinned `agent-browser` engine and Chromium
Headless Shell. A fresh installation needs no separate browser download.
This is an automation browser, not a headed Google Chrome application.
Browser access is on by default, both for the workspace (Settings) and for
each bot (its computer panel); switching either off withholds the browser,
and bundling executables never overrides that switch.

## Package layout and lookup

`pnpm package:prepare` runs `pnpm build:browser`. It downloads verified vendor
archives and stages `dist-native/browser/PLATFORM-ARCH`, copied as
`Resources/browser-engine` on macOS or `resources/browser-engine` elsewhere.
Each package includes only its target architecture: macOS ARM64/x64,
Windows x64, or Linux x64.

The server receives `OMB_RESOURCES_PATH` from Electron. It resolves an explicit
`OMB_AGENT_BROWSER_PATH` override first, then the complete bundled engine and
browser, then a separately installed engine or PATH. An incomplete bundle
fails closed with a reinstall/update message. An explicit
`AGENT_BROWSER_EXECUTABLE_PATH` still overrides the browser executable.
Profiles, cookies and downloads are user data, never packaged resources.

The npm/self-hosted distribution stays small and retains its explicit browser
installation flow. Desktop packaging does not silently enlarge the npm tarball.

## Which Chrome the bots' browser runs

agent-browser still drives every bot browser, but the browser it starts is a
real Chrome whenever this machine has one, chosen once per machine
(`server/browser/chrome/resolve.ts`):

1. The person's installed **Google Chrome**, unless an organization manages it
   (`/Library/Managed Preferences/com.google.Chrome.plist`, the
   `HKLM\SOFTWARE\Policies\Google\Chrome` key, or a JSON file in
   `/etc/opt/chrome/policies/managed`). Bots get their own profiles; the
   person's Chrome profile is never touched.
2. Otherwise **Chrome for Testing** 153.0.8010.47, downloaded once into
   `tools/chrome/` in the data directory at first launch, checked against its
   pinned size and SHA-256 before it is unpacked, and moved into place in one
   rename. Only platforms with a pin download (Apple silicon Macs today;
   `scripts/pin-chrome-for-testing.ts` measures more). A browser call made
   during the download waits up to 45 seconds, then says how far it got.
3. A Linux desktop without Google Chrome, and a platform without a pin, keep
   the bundled headless shell. That stays the machine's choice; it never
   changes while the server runs.

Servers and the Docker image name their browser with
`AGENT_BROWSER_EXECUTABLE_PATH` (the image's Chrome for Testing), or use the
Chrome for Testing `agent-browser install` put in place. `OMB_CHROME_PATH`
names one explicitly. An `OMB_AGENT_BROWSER_PATH` engine keeps its own choice
unless a Chrome is named too.

**Identity.** The chosen Chrome reports exactly what it reports headed, read
from the binary itself once per version: its own user agent without
"HeadlessChrome", and its own client hints (brands, full version list,
platform version, architecture). agent-browser runs a generated launcher
(`browser/chrome-launcher.sh`, `.cmd` on Windows) that adds
`--disable-blink-features=AutomationControlled`, that user agent, the primary
display's size and, when OMB knows it, the language; on a server it also
passes the server's `TZ`. A bot's Chrome never touches the person's keychain
or keyring (`--use-mock-keychain` on macOS, `--password-store=basic` on
Linux), and on macOS it always runs with the person's own home, so no
"keychain cannot be found" dialog can appear. A second DevTools connection gives every page,
cross-site frame and worker the matching client hints before it runs.
Nothing is invented: Chrome for Testing reports Chromium brands, Google Chrome
its own. `OMB_BROWSER_SCREEN`, `OMB_BROWSER_LANG` and `OMB_BROWSER_TIMEZONE`
override the display, language and zone.

`openmausbot browser status`, the server's startup log and the
`browserEngine.chrome` field of its configuration status name the choice, for
example `Google Chrome 155 (installed)`. **Rollback:** start the server with
`OMB_BROWSER_LEGACY_SHELL=1` to run exactly the previous engine.

`node --experimental-strip-types scripts/verify-browser-identity.ts --public`
checks what sites see, in a throwaway home: the identity on a loopback probe
page, then the four public bot-test pages, read-only.

## Signed-in sites and My Chrome

Each built-in browser lists its signed-in sites (Settings → Browser profiles,
or a bot's Browser panel) with Sign out per site and Sign out of all. It works
the same on desktop, a server and Cloud, for an open or a closed browser. A
shared profile can instead use **My Chrome**, the person's own running Chrome,
for sites that refuse the automated one, such as Google sign-in. That needs
Chrome 144+ with remote debugging on at `chrome://inspect/#remote-debugging`,
and either the desktop app or My Cloud with a Mac or PC that lends its Chrome.
That computer lends Chrome only by its own **Your Chrome** switch, off by
default and dropped when lending is turned off; Chrome then travels over the
device link, to the DevTools port the computer finds itself, and only the
person's own conversations and routines use it. My Chrome works only on a
personal Cloud home: on a Team Cloud and on self-hosted servers profiles stay
built-in. Details: [the browser engine plan, step 5](plans/browser-engine.md)
and [MausBot Cloud](cloud-pro.md#your-chrome).

## What a bot's browser can reach

Every Chrome OpenMausBot launches for a bot sends all of its connections
through an egress gate: a SOCKS5 server on `127.0.0.1`, one per browser
session, run by the OpenMausBot server (`server/browser/egress/`). The gate
resolves names itself and checks every address a name resolves to before it
connects, so redirects and DNS rebinding reach nothing it would refuse. It
carries bytes only, so TLS, HTTP/2 and WebSockets are unchanged. Chrome sends
loopback traffic through it too (`--proxy-bypass-list=<-loopback>`), and
WebRTC sends no UDP around it. If the gate is not running, the browser
connects nowhere.

| Destination | Desktop | Self-hosted server | MausBot Cloud |
|---|---|---|---|
| Public internet | yes | yes | yes |
| OpenMausBot's own ports (loopback and this machine's addresses) | no | no | no |
| Other ports on this computer | yes, by `localhost` or an address, not by a public name | only servers a bot's own processes opened (Linux), or allowed below | only servers a bot's own processes opened |
| Local network: 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7 | yes, unless `browserEngine.egress.localNetwork` is `false` | only what `browserEngine.egress.allow` lists | no |
| Link-local and cloud metadata (169.254/16, fe80::/10, `fd00:ec2::254`, 100.100.100.200) | no | no | no |
| 0/8, 198.18/15, multicast | no | no | no |

OpenMausBot's own ports are the server's and its webhook receiver's, the
desktop client relay, the companion and its control page and gateway, the Vite
dev server, the Local VM viewer, every port the server process has listened
on, the ports the desktop app reports, each gate, and agent-browser's stream
servers and Chrome DevTools ports. Servers add their HTTPS edge (8080),
Caddy's admin API (2019) and the ports of fleet workspaces.

"A bot's own processes" means a process in the session of an engine running
a bot's turns, so a dev server the bot started keeps counting after the shell
that started it exits. Other platforms than Linux cannot tell, so there only
allowed destinations are reachable.

A self-hosted server opens more with `config.json`:

```json
{ "browserEngine": { "egress": { "allow": ["192.168.1.0/24", "10.0.0.5:8080", "127.0.0.1:9000"] } } }
```

Each entry is an address or CIDR range with an optional `:port` (IPv6 in
brackets for a port: `[fd12::1]:443`). OpenMausBot's own ports, metadata and
link-local addresses stay closed whatever it lists, and MausBot Cloud ignores
it. Every refused connection shows up in the bot's next browser result:
`The page tried to reach "127.0.0.1:8799" (blocked: OpenMausBot's own service)`.

`agent_browser_read` reads the page open in the browser. Given an address,
agent-browser 0.37 would fetch it with its own HTTP client, around the browser
and the gate, so OpenMausBot does not offer that parameter and refuses a call
that passes one; the bot opens the address first.

My Chrome is the person's own browser and does not go through the gate; the
server never treats a browser as its owner (see
[self-hosting](self-hosting.md#a-browser-signs-in)), and the companion's
control page needs its per-launch token.

## Process hygiene

Each built-in browser is an agent-browser daemon and the Chrome it starts.
agent-browser starts the daemon in a session of its own and Chrome in a
process group of its own, so neither stops with OpenMausBot, and a daemon
nothing closes keeps its Chrome for the engine's one-hour idle timeout. The
same rules hold on the desktop, a server and Cloud:

- **Closing waits for the processes.** `close` answers before the daemon
  has exited (about 150 ms later on a Mac). A browser counts as closed once
  the engine no longer lists it and nothing of the process tree read before
  the close still runs. Past the deadline the daemon gets TERM first, alone,
  so it can still save the sign-ins from its Chrome; whatever is left after
  a short grace is killed by process group, and a process outside those
  groups by its pid (Windows: `taskkill /T`), and Chrome's temporary profile
  folder is removed as the daemon would have. Only a pid file that still names
  this session's daemon is acted on: the same agent-browser binary, with
  `AGENT_BROWSER_DAEMON=1` and the session's name in its environment (on
  Windows, which shows neither, the same image, checked again before
  `taskkill` and while waiting). Each process is matched by its start time,
  so a pid the system gave to another program, another bot's daemon or an
  engine command included, is never signalled. A browser that is not running
  is never sent `close` at all: the CLI would start a daemon only to stop it
  again (and leave its `.config` file behind). On Linux the process table is
  read from `/proc`, so an image without `ps` works the same.
- **Unused browsers close.** A browser nothing has used for
  `browserEngine.idleTimeoutMinutes` in `config.json` (1 to 60; 10 when
  unset, 3 on a MausBot Cloud home, whose 4 GB fits few browsers) is closed: no bot call (a tool listing counts, and so do a call
  waiting behind another, its page-health reads and recorded step, and
  fill_login's typing; a preview frame only holds off a close while it is
  taken), no turn that has used it and is still running, and no person
  holding it or using it through a Browser panel (opening the panel, a
  click, a key, an address, taking or handing back control). A panel that
  only watches does not keep it open: the panel says the browser closed
  after it sat unused and offers to open it again, and on the new engine
  it shows the browser again by itself once the bot's next call starts it.
  It never reconnects on its own, which would start the browser again.
  Saved sign-ins stay, and the bot's next browser call opens it again and is
  told its pages are gone. A temporary browser saves nothing, so it starts
  fresh, and the bot is told its sign-ins went too. A profile set to My
  Chrome is the person's own Chrome and is never closed.
- **Leftovers are swept.** A crash or a kill closes nothing, so the server
  sweeps when it starts, every minute, and at shutdown. It closes only this
  data dir's browsers: each bot's own, each built-in profile's, and its
  temporary browsers, whose names carry a tag of the data dir. On a MausBot
  Cloud home, whose HOME is the server's alone, it also closes the browser
  of any bot that no longer exists (a `bot-` session), within a minute.
  Deleting a bot or profile closes its browser and erases its saved
  sign-ins with the agent-browser OpenMausBot installed, or on a Cloud home
  the image's own; an agent-browser found only on PATH elsewhere just has
  the running browser closed, since a wrapper there could fail the erase
  for good. A Chrome whose
  daemon was killed under it (by the OOM killer, by hand) can never be used
  again: it is found by the session its environment names and stopped, and
  its profile folder removed. Anything else under the same HOME, such as a
  person's own agent-browser sessions, is left alone. Browsers are told
  apart by session name, and agent-browser keeps one daemon per name under a
  HOME: a person's own agent-browser session named like one of this data
  dir's profiles (a profile from before profile ids were random, such as
  `work`), or a copy of this data dir run under the same HOME, shares this
  data dir's browsers, and the sweep closes them as its own. Windows lists no
  environments, so there a Chrome whose daemon was killed is not found.

**Containers.** Chrome's helper processes need something to collect them
once their parent exits, and Chrome needs shared memory. Both Docker compose
files and the Podman one set `init: true` and `shm_size: 512m`, as
OpenMausBot's desktop containers do (`--shm-size 512m`); a plain
`docker run` wants `--init --shm-size=512m`. agent-browser 0.37.0 itself
adds `--no-sandbox` and `--disable-dev-shm-usage` when it sees
`/.dockerenv` or `/run/.containerenv`, runs as root or under CI, or finds
docker, kubepods or lxc in `/proc/1/cgroup`. A runtime that shows none of
these (a Kubernetes pod on cgroup v2, for one) needs `/dev/shm` room of its
own (on Kubernetes, an `emptyDir` with `medium: Memory`). The image does
not set `AGENT_BROWSER_ARGS`: OpenMausBot hands its browsers a curated
environment that would not carry it. On Fly Machines (the Cloud home) Fly's
own init runs as PID 1.

## Video recording

The macOS and Linux engine is pinned to agent-browser 0.37.0. Its
[`record start` and `record restart`](https://agent-browser.dev/recording)
commands record the active page at 30 fps by default; `--fps 60` selects 60 fps
(valid range: 1–60). This saves a video file; it does not enable a live view.
Recording requires `ffmpeg` on the server's PATH, with `libvpx` for WebM or
`libx264` for MP4. `agent-browser doctor` reports these optional dependencies.
They are not bundled or required for normal browsing. Higher frame rates use
more CPU and disk space; the actual distinct frames depend on page repaints.
There is no recording control in OMB's browser panel.

## Linux sandbox

Use the `.deb` on Ubuntu 24.04. Its package hooks install a narrowly scoped
AppArmor policy for the root-owned browser executable under `/opt/OpenMausBot`.
They do not disable the browser sandbox or change the global user-namespace
restriction. See [Linux desktop](linux-desktop.md).

The AppImage contains the same binaries, but cannot install a privileged
sandbox policy. Restricted hosts may need the `.deb` rather than the AppImage.

## Release verification and updates

Versions, URLs, sizes and SHA-256 digests live in
`server/browser-bundle-release.ts`; engine pins are shared with
`server/browser-engine-release.ts`. Every cached download is rechecked.
Preparation inventories the entire vendor tree, including licenses. The
`afterPack` gate rejects missing resources, changed bytes or wrong executable
architectures before signing. macOS signing changes native bytes, so signed
packages are subsequently checked using code signatures and runtime tests,
not the original upstream executable hashes.

Run the real browser check against an unpacked app:

```sh
node scripts/smoke-browser-bundle.mjs --resources /absolute/app/resources
```

On macOS, use `/absolute/OpenMausBot.app/Contents/Resources`. On Linux, run as
an unprivileged user against the installed `.deb` at
`/opt/OpenMausBot/resources`. This check creates its own empty home and local
web page, checks automatic discovery, navigation, typing/clicking, the
loopback command relay the server reads, pictures and types through
(`server/browser-relay.ts`), screenshot delivery and two-bot cookie/storage
isolation, then removes only its fixture.
No model account or user browser profile is used. Cross-target `--check-only`
checks layout only and is not evidence of successful browser execution.

The release workflows run this check on native macOS, Windows and Linux
runners before publishing. macOS also verifies the browser binaries are signed
with the app's team identity. The browser is updated through a reviewed app
release: review the new vendor target/license contents, update all platform
pins, run preparation/tests and the native package gates, and ship promptly
when browser security updates are needed. There is no independent automatic
browser updater in the desktop bundle.

### Temporary Windows engine backport

Windows uses an explicitly identified OpenMausBot build of agent-browser
0.36.0, with the handle-inheritance fix from
[upstream PR #1781](https://github.com/vercel-labs/agent-browser/pull/1781).
The official 0.37.0 release does not contain this fix, so Windows stays on the
native-verified `0.36.0-omb.1` revision and does not yet get the new recording
options. Do not replace it with the unpatched 0.37.0 Windows binary.
The original binary can hang when a newly started background browser holds
the tool call's output connection open. The backport changes that Windows
startup behavior; it does not include the PR's broader output-reader rewrite
or unrelated changes from upstream main.

The artifact-only **Windows browser vendor build** workflow builds the pinned
source and checked-in patch, retains the licenses and build provenance, and
tests cold start plus close/reopen through the same MCP connection on Windows.
Its candidate must be reviewed and its exact size and SHA-256 pinned before
the normal application packaging workflow consumes it. Candidate testing does
not replace the packaged-app tests. Published vendor bytes must not be
overwritten; a changed build needs a new revision and reviewed pins.

The Windows revision has a separate managed installation directory so an old
0.36.0 download is not mistaken for the patched engine. Desktop packages use
their bundled engine. Explicit executable overrides remain user-managed.
Remove the backport when an official release includes the fix and passes the
same native cold-start and restart tests.

Complete upstream notices and provenance are in
[`third_party/browser`](../third_party/browser/README.md). The full Google
Chrome distribution and its proprietary Widevine component are not bundled.
