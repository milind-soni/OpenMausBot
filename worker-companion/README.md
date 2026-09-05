# OpenMausBot worker companion

The versioned helper that runs as the non-administrative interactive worker
user on a macOS or Windows desktop. It has no listener. OpenMausBot reaches it
only through the operator-owned OpenSSH alias and the fixed
`openmausbot-worker-companion stdio` command.

Build on the Mac with `pnpm build:worker-companion`, copy
`worker-companion/package.json` and `worker-companion/dist/` to the worker,
install dependencies there, and expose the package's
`openmausbot-worker-companion` bin on that user's `PATH`. Node 24 or newer is
required.

## Protocol 1

One out-of-band flag is read by the control plane's health probe:

- `--version` prints `openmausbot-worker-companion 1`. The probe parses the
  trailing integer as the protocol version and refuses any worker that does not
  answer exactly `WORKER_COMPANION_PROTOCOL_VERSION`.

On macOS, the control plane reads TCC state directly from the running daemon
with a non-prompting `check_permissions` call and requires `driver-daemon`
source attribution. A standalone companion or SDK read would report the SSH
process's responsible application rather than the daemon's grant.

`stdio` accepts one bounded JSON request per line. The two operations that
bound a worker at rest are:

- `pause` — revoke every capability and stop the driver.
- `resume` — write the built-in non-action parked capability and bring the driver
  back up bounded through the fixed Windows Scheduled Task or dedicated macOS
  `com.openmausbot.cua-worker` LaunchAgent. Both parked manifests name only
  `check_permissions`: macOS constrains it to a non-prompting TCC read, while
  the Windows base policy does not admit it at all. Neither can observe or
  control the desktop until a task capability is approved.

The task layer also uses fixed `stage`, `reset`, `validate`, `activate`, `run`,
and result-fetch operations. Executables, arguments, working directories and
result paths come only from the staged, hashed, human-approved manifest; the
wire cannot substitute them. It never accepts environment variables, policy
bodies, capability YAML, an SSH endpoint, or an arbitrary command.

Staging writes an immutable approved-input baseline outside the CUA-granted
task root. VS Code may edit the working copy; later commands and result reads
revalidate the baseline plus current no-symlink and size bounds. Patch and
result files are produced by the exact approved workflow, not synthesized by
the companion.

Approved computer actions do not ride a persistent remote MCP proxy. The
worker-only MCP server asks the control plane to invoke `cua-driver describe`
or `cua-driver call` as a bounded one-shot SSH operation, with call arguments
on stdin. This keeps capability restarts independent of the shared IDE/CLI,
Local VM, and VPS MCP bridge.
