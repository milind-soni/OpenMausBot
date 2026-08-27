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

Two out-of-band flags, read by the control plane's health probe:

- `--version` prints `openmausbot-worker-companion 1`. The probe parses the
  trailing integer as the protocol version and refuses any worker that does not
  answer exactly `WORKER_COMPANION_PROTOCOL_VERSION`.
- `--permissions` prints `{"accessibility":bool,"screenRecording":bool}` on
  macOS, read live from the pinned CUA SDK's non-prompting
  `currentMacOsPermissionStatus()`. This has no Windows analogue, so on Windows
  it prints `{"accessibility":null,"screenRecording":null}` and the Windows
  ladder never consults it.

  The read is live on every poll by design: macOS TCC grants are per-binary,
  System Integrity Protection blocks writing the TCC database, and replacing the
  driver binary silently revokes them. A grant made once during setup is not
  evidence of a grant now.

`stdio` accepts one JSON request per line. This version implements the two
operations that bound a worker at rest:

- `pause` — revoke every capability and stop the driver.
- `resume` — write the built-in deny-all parked capability and bring the driver
  back up bounded. The parked manifest grants no tools at all, so a resumed
  worker is reachable and provably bounded and can do nothing until a task
  capability is approved.

It never accepts executable names, arguments, environment variables, working
directories, policies, or capability YAML over the wire. The task-manifest
operations (`reset`, `validate`, `activate`, `run`) land with the server-side
task layer.
