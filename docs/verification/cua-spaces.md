# Cua Spaces Local VM backend

Design: [../cua-spaces.md](../cua-spaces.md).

## Automated

```sh
pnpm exec vitest run server/cua-spaces-api.test.ts server/cua-spaces-computer.test.ts server/testing/fakes-self-contained.test.ts server/system-prompt.test.ts src/lib/local-vm-readiness.test.ts src/components/LocalComputerSection.test.ts src/components/LocalComputerSection.cua.test.ts src/components/ComputerPanel.simple.test.ts src/components/bot-settings/AccessSection.test.ts src/lib/local-vm-workspace.test.ts src/state/bot-patch-queue.test.ts
node --test electron/desktop-viewer.node-test.mjs
```

The adapter tests script the `cua` CLI through the injected runner: status
mapping (missing, starting, ready, suspended, broken), version and Apple-silicon
gates, an unreachable daemon, create failures surfacing Cua's own reason,
lifecycle guards and exact argv, watch-only versus interactive viewer links,
loopback-only links, and `vm_exec` quoting and limits.

The focused UI tests assert that pool seats never expose bot-level
Create/Start/Delete, the Shared Space card exists only in shared mode,
unmanaged existing names have no lifecycle controls, and missing shared or
per-bot Spaces can be created. Access tests hide the bot OS selector in pool
mode and explain its default OS. Shared deletion names the shared Space,
not the bot's private Space.

Readiness tests use fake clocks rather than sleeps: container 60 s, Linux
Space 90 s, macOS Space 5 min, including a stalled status request and
selection cancellation. Panel/settings handler tests retain the last problem
after timeout and release controls for Start retry. The Electron URL test
injects host platform/interfaces, allowing `bridge100`–`bridge199` guests only
on Darwin and rejecting LAN, `bridge0`, other subnets and non-Darwin bridges.

Real-server API tests must set `OMB_CUA_CLI` to an absolute **fake** executable
and use temporary `HOME` and `OMB_DATA_DIR`. The override fails closed if
invalid; it never falls back to a real PATH CLI. Ownership fixtures must
create the data-dir receipt, not just a Space with an OpenMausBot-like name.
Synchronize fake CLI commands through events/gates, not sleeps. No automated
case may create, inspect or delete the user's Spaces.
`server/cua-spaces-api.test.ts` supplies that environment with the
self-contained fake CLI and a private loopback `FAKE_CUA_API` command stub;
its HTTP response gates record command entry before release. It shadows
container runtimes too, so a container backend fallback cannot reach a real
daemon. Seed existing owned test Spaces through
`recordCuaSpaceOwnership(name, fixture.dataDir, added_at)` as well as the fake
registry; newly created test Spaces get their receipts from the adapter.

## Rendered UI evidence

The hook/markup tests above do not supply screenshots or prove a packaged
viewer. The existing isolated renderer regression is practical for checking
that the **container** stopped → pending → ready flow remains unchanged:

```sh
node --experimental-strip-types scripts/verify-local-vm-resume.ts
```

It uses a disposable server/profile and synthetic transport, saves stopped,
starting and ready screenshots beside the fixture log, and can record video
with `OMB_UI_RECORD=1` (ffmpeg required). `OMB_UI_EVIDENCE_DIR` changes the
destination. It does not claim Space-specific rendered evidence.

For Space-specific before/after captures, connect the real renderer only to
an isolated server configured with the fake CLI and temporary data/home, then
capture this matrix:

1. Shared missing Space: Settings shows Create; the bot panel shows Create.
2. Per-bot missing Space: Settings has no Shared Space card; bot Create remains.
3. Pool missing/stopped/ready seat: no bot Create/Start/Delete; Access explains
   default OS, with no editable bot OS selector.
4. Unmanaged running/stopped collision: visible `problem`, no lifecycle actions.
5. Shared Delete: cancellation dialog names the shared Space, not the bot.
6. Start/Create with held readiness: controls stay pending; after the OS
   deadline, last status/problem stays visible and Start is enabled for retry.

Use fake command/status gates for state transitions. The stock `control-omb
launch` only forwards its documented fixture variables, not `OMB_CUA_CLI`;
set that override in the isolated **server child** environment rather than
assuming it reaches the child. Do not use a live app for this matrix.


## Live

Needs Cua Spaces installed on the machine running the check (`cua --version`
≥ 0.2.0, Docker for Linux Spaces). It creates and deletes one disposable Space;
it never touches the user's OpenMausBot data.

1. Start a fixture server with a temporary `OMB_DATA_DIR` and the fake engine
   (`verificationServerEnvironment` from `scripts/control-omb.ts`), but keep
   the real `HOME` and add `~/.local/bin` to `OMB_EXTRA_PATH` so `cua` finds the
   Cua Spaces daemon.
2. `GET /api/local-computer/cua-spaces` → `installed: true`, `problem: null`.
3. `PATCH /api/config {"localVm":{"backend":"cua-spaces","mode":"per-bot"}}`,
   then `PATCH /api/bots/:id {"computer":"vm"}`.
4. `POST /api/bots/:id/local-computer/run` → `backend: "cua-spaces"`,
   `ready: true`, `space_name: openmausbot-computer-<16 hex>-linux`; `cua
   spaces ls` lists it as `OpenMausBot: <bot name> (Linux)`. Rename the bot
   (`PATCH /api/bots/:id {"name":"…"}`): the label follows, the sandbox name
   does not change.
5. `POST …/screenshot` → a PNG data URL. `POST …/viewer {}` → a loopback
   `…/viewer/#ticket=…` link without `clipboard=0` (the watch-only marker), and
   no computer-control hold is taken. Loading that link in an Electron
   window configured like the app's live-desktop window renders the desktop.
6. Send a message: the fake engine's `FAKE_CLAUDE_DUMP` shows the `computer`
   MCP server as `cua-spaces-mcp.ts <cua> local:<space>` with only the control
   pair in its env, and the system prompt's Space paragraph.
7. Spawn that exact MCP descriptor: `ping` answers, `tools/list` has the 35
   `computer_*` tools and no Space lifecycle tools, `computer_screenshot`
   returns an image. With the turn's (now stale) control token the gate
   refuses the call.
8. `stop` → `container: "stopped"`, `resumable: true`; `start` → ready.
   `remove`, then send a message: the turn recreates the Space itself before
   the engine starts.
9. Clean up: `cua sb rm local:<space> --force` and `cua spaces rm local:<space>`.

2026-10-03, macOS 27 (Apple silicon), cua 0.2.0, Docker Desktop: steps 1–9
passed for a Linux Space (create ≈ 3–50 s depending on the image cache; stop
and start well under a second). `vm_exec` returned exit codes and stdout, and a
2 s limit ended `sleep 30` with exit 124. `attach_file` staging copied
`out/report.txt` and `/home/cua/out/report.txt` and returned nothing for a
missing file.

Found while verifying (cua 0.2.0): `cua spaces delete` removes the sandbox
behind the daemon's back. The daemon keeps listing it as running/ready and
keeps routing that name to the dead Space, so a recreated Space of the same
name fails every screenshot and tool call (`env: rpc failed: transport error`)
until the daemon restarts. OpenMausBot therefore deletes with `cua sb rm`
(through the daemon) and then forgets the registration with `cua spaces rm`,
and reads status from the embedded listing (`--embedded`), which stays
accurate even after someone else's `cua spaces delete`.

2026-10-03, same Mac, after turning on Local Network for the Cua Spaces app:
a macOS Space (`ghcr.io/trycua/macos:26-slim`, macOS 26.5.2) passed steps 3, 4
and 6–8 with `vmOs: "macos"`, and its viewer link (step 5) is handed on; opening
that link in a browser was not checked.
Create took ≈ 50 s with Cua's base image already
cached (the first download is ≈ 27 GB); `vm_exec` ran `sw_vers` as `lume` in
`/Users/lume`; the turn mounted the macOS paragraph and the same 35 tools;
`computer_screenshot` returned 1024×768 frames; stop then start was ready in
43 s. Before that permission was on, creating stopped at Cua's own error —
"Local Network access is not available … turn on Cua Spaces in System
Settings > Privacy & Security > Local Network" — which OpenMausBot reports as
the Space's problem.

A macOS Space's viewer link points at the VM on the Mac's Virtualization NAT
bridge (`http://192.168.64.N:3211/viewer/…`), not loopback, so the route
accepts that bridge's subnet too. The browser that opens it needs Local
Network access as well; a process without it gets `EHOSTUNREACH`.

The bridge exception is Darwin-only. The macOS viewer's HTML originates in
the guest and can be changed by the bot. Its selected origin receives host
clipboard read/sanitized-write, keyboard-lock, pointer-lock and fullscreen
permissions like the container noVNC viewer. Opening it therefore trusts that
guest content; Take control is not a content-security boundary. Cross-origin
embeds and other privileged permissions remain denied. The URL tests prove
platform/subnet gates, not the safety of an arbitrary guest-served viewer.

Ownership receipts live in the isolated app data directory's
`cua-space-ownership/<sha256 sandbox-name>.json`, written before creation and
bound to Cua's `added_at` when available. A name-only collision remains
unmanaged and must not be relabelled or deleted during verification.
Attachment paths containing `:` must fail with 400 before `cua sb cp`.
The macOS guest execution watchdog terminates the guest process group and
preserves exit 124 as `{ exitCode: 124, timedOut: true, stdout, stderr }`;
automated fake coverage does not prove live guest process cleanup.

2026-10-03 review follow-up: the live Linux adapter smoke passed ownership
receipts, unmanaged-name refusals, colon-path 400 rejection, ordinary
attachment staging, missing-file `null`, and sandbox/registry/receipt removal.
A fresh macOS attempt with the base image cached failed after 622.92 s:
the guest daemon at `http://192.168.64.6:3211/` did not answer; Cua removed
the sandbox, and later exec/log requests reported it missing. That attempt
could not exercise the guest watchdog. A separate **host-side** watchdog
check ended `sleep 30` at a 3 s limit with exit 124, `timedOut: true`, and
the sleep process absent afterward. This proves host cleanup only, not
macOS guest process-group cleanup or a successful current macOS viewer.
