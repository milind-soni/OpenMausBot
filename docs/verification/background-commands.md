# Tracked background command completion

Use disposable SQLite, a fake turn runner, and the isolated loopback Boat
provider. No real model, user data, or cloud account is needed.

```sh
pnpm exec vitest run server/runtime/runtime.test.ts server/runtime-coordinator.test.ts server/host/room-transcript.test.ts server/host/tracked-cloud-command.test.ts server/cloud-computer-background.test.ts
```

Check that a tracked cloud command can complete after its worker's turn ends.
Its result goes to the original assignment through the runtime queue without
another person message. Exit 0 and nonzero exit codes go through the same
verification turn. A duplicate completion or an already read terminal result
does not produce another turn. The room continuation keeps command evidence
when the transcript already contains the assignment and teammate reports.

Reopen the disposable SQLite store during verification to check that an existing
outward-action receipt prevents replay, while unfinished verification without a
receipt can continue. The original computer and access are rechecked before
reading or dispatching the result. Output is scrubbed and treated as information,
not new instructions or permission.

Only commands registered from running, person-origin work outside goal runs
are eligible. Tracking is bounded to two hours and 20 commands per assignment.
An unregistered command retains its existing manual `exec_status` guidance.
Expiration reports an unknown outcome, not success. Stopping the task cancels
continuation; it does not kill the detached process. Agent CLI launches are
outside this workflow.
