# HEL1 office workflow

Use **Your office** to give the Chief a project, a concrete job and the result you need. The Chief uses native `coordinate_bots` hand-offs and returns their results to the source conversation. Ask for status when needed; no model polling or recurring monitor is installed. Use **Cancel job**, or ask the Chief to cancel a specific job. Ordinary **Stop** still stops the current conversation turn.

## Execution boundary

- HEL1 runs the Chief, specialist Codex processes, tools, tests and builds using the existing worker-local OAuth sign-in.
- `orch-hel1` runs a bounded deterministic SSH handler that reads authoritative attempt metadata and commits a single-use directive. It runs no agent or model for this workflow.
- Goliath remains suspended and ineligible. Office processes remove inherited proxy and vault settings. Existing native bot and project permissions still apply.
- Each native root has a fixed 30-minute work deadline, inherited by hand-offs and continuations without extension. Expiry stops local execution; native partial reports remain available. Tool-enabled model synthesis cannot start after expiry.
- Unknown process exit is reported as partial/uncertain and blocks another attempt on the same bot/thread, including after server restart. A database cancellation alone is not proof of process exit.

The optional worker startup setting `OMB_OFFICE_CONTROL_CONFIG` points to a private, worker-owned JSON file. In this deployment it is `/home/orca/.local/state/openmaus/normal-workflow/office-control.json`:

```json
{
  "version": 1,
  "workerId": "c7fbfb41-e544-4c72-b741-fa12536a290a",
  "controllerHost": "orch-hel1",
  "host": "100.103.173.81",
  "port": 2222,
  "user": "orca",
  "identityFile": "/home/orca/.local/state/openmaus/normal-workflow/ssh/controller_rpc_ed25519",
  "knownHostsFile": "/home/orca/.local/state/openmaus/normal-workflow/ssh/known_hosts"
}
```

The key is generated on HEL1 and is never exported. The controller uses the existing OpenSSH service on its private port 2222: source HEL1 only, dedicated authorized-key file, fixed command, public-key authentication, no shell/PTY/forwarding/user rc. This avoids interactive Tailscale SSH checks without changing existing operator access. Its handler is [controller-rpc.py](controller-rpc.py); its private policy is `/var/lib/orca/.local/share/openmaus-controller/office-policy.json`.

Controller policy permits the existing known bot profiles and exact configured folders. Shared-project hand-offs may use the exact snapshot of configured `/home/orca/openmaus-projects/` folders; arbitrary paths, subdirectory-prefix expansion and private data folders are not shared grants. The worker also verifies the native task's actual pinned folder, model selection, tool scope and permission before provider launch and prompt submission.

Office mode initially supports the existing Codex Ask profiles. Internal model helpers, native subagents, cache warming and unsupported automatic-review modes are disabled or refused. NVIDIA's earlier Mac-broker evaluation is not a normal-workflow dependency.

## Transport and recovery

The desktop already uses an automatic, public-SSH, forward-only connection to HEL1 at `http://127.0.0.1:38799/`. Assigning a job does not require opening a terminal or changing the Mac's Tailscale account. The private HEL1/controller connection is managed by the servers themselves.

Worker `runtime.db` remains the only job store. No second queue, scheduler, recurring model call or controller HTTP listener is added. An unavailable controller prevents a new provider start. An admitted job can finish within its existing deadline; local cancellation does not wait for controller availability.

Deployment must bind checks and built server/UI artifacts to exact source hashes, wait for native work to become idle, preserve all bot profiles and conversation data, and retain the previous bundle, UI and supervisor for rollback. Uncertain jobs need an explicit confirmed local stop before quarantine can be cleared; never infer that from a terminal database status.
