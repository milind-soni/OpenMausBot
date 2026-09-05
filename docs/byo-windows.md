# Bring your own Windows worker

OpenMausBot keeps its control plane on the Mac and connects a bot to an
already-running Windows physical machine or VM. It does not provision
Windows, manage a hypervisor, store SSH credentials, expose a TCP control
listener, mount the Mac workspace, or fall back to Linux when Windows fails.

Docker remains the recommended Local VM and protocol-test path for Linux. A
Linux container cannot supply the interactive Windows desktop, Session 1+
window station, Windows UI Automation, registry, and named-pipe behavior this
backend must verify. Use a real Windows installation in Parallels, VMware,
UTM, another local hypervisor, or a physical PC.

## Desktop admission hold

Windows desktop tasks are currently unavailable. Live acceptance against the
pinned official CUA Driver 0.20.0 failed the application restriction: an
unapproved application launched, while a state read for an approved application's
window was rejected. The control plane refuses these tasks before approval or
staging, and the companion independently refuses desktop activation before
changing the capability or starting the daemon. Healthy SSH, matching loaded
hashes, and successful command/result transport do not lift this hold.

Keep affected workers paused with their parked capability. Remove the hold only
after a reviewed driver replacement passes the real allowed-application state,
click and type checks and rejects unapproved applications and path escapes.
The separate typed-browser surface is not covered by this desktop acceptance;
it still needs its own live origin and profile tests before admission.

## Security model

The operator owns the Windows installation and the macOS OpenSSH alias. The
Windows account must be a dedicated non-administrator user. OpenMausBot stores
the alias with the worker's platform, display name, pinned driver and policy
digests, and optional browser/IDE paths. SSH credentials stay entirely in the
operator-owned SSH configuration.

Readiness checks the live SSH token and refuses an account in the local
Administrators group. Installing the driver under an administrator account
does not make that account an eligible worker.

Every task has three independent fences:

1. A stable, deny-by-default CUA YAML policy limits the total tool ceiling.
2. A short-lived native CUA version-3 capability manifest limits one task to
   either typed browser tools and exact origins, or generic input against VS
   Code and File Explorer under the staged task root. CUA does not permit
   browser origins and generic desktop input in one runtime; OpenMausBot keeps
   those task surfaces separate.
3. A version-1 OpenMausBot task manifest binds the target, expiry, idle
   timeout, staged file hashes, exact non-GUI commands, argv, working
   directories, origins, results, and base-policy digest. The agent-facing
   `worker_task_run` tool accepts only a command ID from the approved task.

Only one bot can lease a given Windows target. Work on another worker — a
[macOS guest](byo-macos.md), for instance — and on Linux Local VMs continues
in parallel: workers are named independently and lease independently.

Returned files are streamed back only through the bounded task result tool and
do not overwrite the canonical Mac workspace.

## Windows prerequisites

Use Windows 11 or a currently supported Windows Server desktop with:

- Windows OpenSSH Server configured by the operator;
- Node.js 24 or newer;
- official CUA Driver 0.20.0;
- Chrome and VS Code at the paths entered in OpenMausBot;
- a dedicated Chrome profile named **OpenMaus Windows Worker**, with Sync,
  personal accounts, and unrelated extensions disabled.

Install the driver and verify its exact version from an interactive PowerShell
session. Follow the official CUA install instructions for the pinned release;
do not use an unreviewed wrapper or ambient alternate binary.

```powershell
cua-driver --version
node --version
```

## Install the companion

Build the companion from the exact OpenMausBot source commit on the Mac:

```bash
pnpm build:worker-companion
```

Copy only `worker-companion/package.json` and `worker-companion/dist/` to a
private directory owned by the Windows worker user, install its dependencies
there (`npm install --omit=dev`), then expose the package's
`openmausbot-worker-companion` bin on that user's `PATH` (for example with
`npm link` from that copied directory). Verify protocol 1:

```powershell
openmausbot-worker-companion --version
```

The companion has no listener. Its fixed stdio protocol accepts pause, resume,
reset, validate, activate, run, stage, and bounded result-fetch operations; it
never accepts a caller-selected executable or transport endpoint. Activation derives the CUA capability YAML from
the already-approved manifest, stops the old immutable daemon, restarts the
fixed official CUA autostart task,
rechecks that the executable is Driver 0.20.0, and requires `cua-driver status`
to report both bounded mode and the exact capability digest. It never accepts a remote executable, argv, environment,
working directory, policy body, capability body, or arbitrary command.
Validation freezes an immutable source baseline outside the CUA-granted task
root. Later VS Code edits are allowed within the bounded task root;
`worker_task_run` revalidates the untouched baseline and current path/size
limits before it runs the exact approved command. OpenMausBot does not invent a
patch: the approved workflow must write its declared `changes.patch` and
`result.json`, and the result tool returns only those declared paths.

## Install the native policy stack

Create `%LOCALAPPDATA%\OpenMausBot` for the Windows worker user. Copy
`docs/windows-base-policy.yaml` to
`%LOCALAPPDATA%\OpenMausBot\windows-policy.yaml` and copy
`docs/windows-parked-capabilities.yaml` to
`%LOCALAPPDATA%\OpenMausBot\active-capabilities.yaml`.

The parked manifest names only `check_permissions` because CUA 0.20.0 rejects
an empty tool list. That macOS-only tool is absent from the Windows base
policy, so the effective parked intersection grants no callable tool. CUA also
caps bounded lifetimes at 24 hours; task activation restarts the daemon with a
fresh short-lived manifest.

Set the trusted launch environment for that user from an interactive
PowerShell session. These variables are read when the daemon starts; they are
not agent-controlled tool arguments.

```powershell
$root = Join-Path $env:LOCALAPPDATA 'OpenMausBot'
New-Item -ItemType Directory -Force -Path $root | Out-Null
[Environment]::SetEnvironmentVariable('CUA_DRIVER_POLICY_FILE', (Join-Path $root 'windows-policy.yaml'), 'User')
[Environment]::SetEnvironmentVariable('CUA_DRIVER_PERMISSION_MODE', 'bounded', 'User')
[Environment]::SetEnvironmentVariable('CUA_DRIVER_CAPABILITY_MANIFEST_FILE', (Join-Path $root 'active-capabilities.yaml'), 'User')
[Environment]::SetEnvironmentVariable('CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED', '1', 'User')
```

Log out and back in so the Scheduled Task receives the trusted environment.
Then register and start the official interactive-user task:

```powershell
cua-driver autostart enable
cua-driver autostart kick
query session
cua-driver status --socket \\.\pipe\cua-driver
```

The session must be `Active` or `Disc`, never Session 0. The status output must
show bounded mode and hashes for the loaded policy and capability file. An
unset policy variable means policy enforcement is disabled; OpenMausBot checks
the loaded digest, not merely the file on disk. Readiness also requires the
session ID of the actual named-pipe server process to match an Explorer desktop
owned by the SSH user. The probe verifies both process owner SIDs with query-only
Windows token handles; CUA 0.20.0 does not print a session ID, and WMI ownership
queries can be unavailable to a non-administrator SSH token. Another user's
interactive session cannot satisfy the gate.

The registry pins the raw file SHA-256 values below. CUA 0.20.0 reports different
loaded fingerprints: its policy hash includes a domain separator, filename and
lengths, and its capability hash includes a versioned domain separator. The
probe and companion verify the pinned file bytes before deriving and comparing
these loaded fingerprints; do not replace registry pins with status hashes.

Compute both stable digests and record them in the worker registry:

```powershell
(Get-FileHash -Algorithm SHA256 (Join-Path $env:LOCALAPPDATA 'OpenMausBot\windows-policy.yaml')).Hash.ToLowerInvariant()
(Get-FileHash -Algorithm SHA256 (Join-Path $env:LOCALAPPDATA 'OpenMausBot\active-capabilities.yaml')).Hash.ToLowerInvariant()
```

## Configure the Mac

Create a normal OpenSSH config alias outside OpenMausBot. Authentication,
host-key policy, keys, passwords, and agent state remain owned by macOS and
must not be pasted into OpenMausBot. Add only the validated alias, exact driver
version, both public digests, application paths, and profile name through the
admin config API, or while OpenMausBot is stopped in the owner-only
`~/.openmausbot/config.json` `workers` object.

The backend invokes only these fixed remote surfaces:

```text
ssh ... ALIAS openmausbot-worker-companion stdio
ssh ... ALIAS openmausbot-worker-companion stage TASK_ID
ssh ... ALIAS openmausbot-worker-companion fetch TASK_ID MANIFEST_SHA256
ssh ... ALIAS cua-driver describe APPROVED_TOOL
ssh ... ALIAS cua-driver call APPROVED_TOOL --socket \\.\pipe\cua-driver
```

Computer-call arguments are written as JSON on stdin and never placed in SSH
argv. The stable worker MCP surface is local to OpenMausBot, so changing a
worker capability cannot restart or mutate any IDE/CLI bridge. The backend
does not accept a hostname, SSH options, shell string, or arbitrary remote command
from a bot or task manifest. The local SSH/SFTP child environment is an
allow-list containing only PATH, the operator home/user metadata, locale,
temporary-directory metadata, and `SSH_AUTH_SOCK`; ambient API keys and the
OpenMausBot control token are excluded. Staged and result bytes use framed
streams over those fixed companion subcommands; no SFTP path is caller-selected.

## Transport spike and acceptance

Before assigning real work, read `/api/workers` from the authenticated desktop
session and run a bounded test task to prove:

- SSH authentication through the named alias;
- Driver 0.20.0 and companion protocol 1;
- an unlocked Session 1+ desktop;
- named-pipe access from OpenSSH;
- loaded base-policy and native capability digests;
- one allowed screenshot/state read, click, and type on the correct surface;
- rejection of a disallowed tool, application, origin, and staged-path escape;
- bounded result collection through the task result tool without a workspace overwrite;
- no non-loopback listener introduced by OpenMausBot or the companion.

If named-pipe access returns `Access is denied`, stop. Do not loosen the CUA
pipe ACL and do not switch to an unrestricted daemon. The optional same-user,
same-session relay described by the design is intentionally not enabled until
the failure is reproduced and the relay passes its isolation suite. Without
that proof, Windows remains unavailable and never falls back to Linux.

## Browser boundary

Browser tasks expose typed browser tools only. Every navigation and input is
checked against the exact scheme, host, and port in the task manifest. Generic
desktop screenshots, window trees, clicks, and keystrokes are absent from that
runtime because they could read or operate a different tab without crossing
the origin check. Credentials, MFA, CAPTCHA, and consequential accounts remain
operator actions. The native capability binds the configured Chrome executable
and the `existing_profile` attachment class. CUA intentionally does not return
the profile's identity; the operator must verify that the selected native
window is the dedicated **OpenMaus Windows Worker** profile during the transport
spike and before each consequential browser task.

The intended desktop scope is VS Code and File Explorer only; desktop admission
remains held as described above. Chrome is not an allowed
application on that surface. A workflow that needs both must use two visible
tasks/handoffs; it cannot combine the permissions in one manifest.

`worker_task_run` confines its working directory and prevents executable, argv, or
environment substitution after approval. It is not an operating-system sandbox
around the approved executable: that exact program still has the ordinary
rights of the dedicated Windows user. Approve only purpose-built build/test
binaries whose behavior is appropriate for that account.
