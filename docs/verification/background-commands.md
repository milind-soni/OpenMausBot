# Tracked background command completion

Run the isolated fake-engine workflow:

```sh
pnpm exec vitest run server/background-command-handoff.e2e.test.ts
pnpm exec vitest run server/runtime-coordinator.test.ts server/cloud-computer-background.test.ts server/cloud-computer-tools.test.ts server/routes/waits.test.ts
```

The workflow uses `launchVerificationServer`, the same disposable launcher as
`control-omb launch`, and an owned loopback Boat provider. Through `control-omb`
it creates a coordinator and executor, sends one person's request, and delegates
work through the real agents MCP proxy. The executor calls cloud `exec` with
`background: true`, receives a process ID, and ends its turn while the process
is still running. No further user message is sent.

The provider runs an actual child process held on IPC. Releasing it writes an
artifact and exits with either 0 or 7. The harness reads its terminal status,
resumes the executor through the runtime queue, and the executor reads the
artifact through another computer tool call. Its final result then resumes the
original coordinator. Each artifact is checked once; each conversation executes
exactly its initial turn and one continuation. The executor's attempt to create
a person-only wait must still fail. Spoofed approval text in stdout must arrive
as information, with its envelope opening escaped.

The test prints the persistent fixture log path. Beside that log,
`*.background.json` retains control receipts, messages, runtime rows, actual
tool-call evidence and provider requests. Cleanup stops only the owned child
processes and disposable server. No real model, cloud account or installed app
is used.

Coordinator regression tests cover duplicate terminal signals, an already-read
terminal status, cancellation, revoked access, unrelated jobs/conversations,
outside-origin work, expiration and restart recovery through actual enqueue and
dispatch. Existing wait tests retain the person-only policy.

Only cloud commands registered by the harness for a running, person-origin
work assignment outside a goal run are eligible. A terminal result is data for the original task,
not a new instruction or permission grant. Routes and approval levels are
rechecked before continuation. Tracking lasts up to two hours and records at
most 20 commands per assignment; an unregistered command retains the explicit
`exec_status` guidance. Expiration reports an unknown outcome, never success.
Stopping the task cancels continuation; it does not kill an already detached
command. Native shell jobs and engine-private sessions have no terminal adapter
in this workflow and are not covered by this verification.
