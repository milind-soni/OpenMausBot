# Work summaries and engine hooks

This records observed work, not proof that a task succeeded. A command receipt
deduplicates a synchronous SQLite write; it does not make file or provider
actions transactional, nor authorize a deployment.

## Drive and evidence

```sh
pnpm exec vitest run server/digest-control.e2e.test.ts
pnpm exec vitest run server/commands.test.ts server/store.test.ts server/message-db.test.ts server/digest.test.ts server/checkpoints.test.ts server/hooks/omb-hook.test.ts server/hooks.e2e.test.ts server/digest.e2e.test.ts
```

The first test starts `launchVerificationServer`, then uses the shared
`control:omb` surface to create two bots, send consecutive direct turns,
wait for settlement, create a room, send to it, and read both transcripts.
It checks per-turn hook results (including reused tool IDs), unique persisted
receipts and the room speaker. Commands, wait results and transcripts are
retained beside the printed server log. Its temporary home is removed in
`finally`; no real account or user workspace is involved.

The other isolated suites cover transaction rollback, nested savepoints,
commit-before-broadcast, hook redaction, bounded previews and private result
files, compaction context, an opt-out, checkpoint file lists and replay into
another fake engine. The multi-engine and older hook suites currently run on
POSIX; the shared-control test is cross-platform. CI must establish Windows
behavior rather than treating a local macOS run as Windows verification.

## Boundaries

- A summary contains the visible tool calls, bounded memory changes and a
  short reply. It is based on observed rows, not inferred provider capabilities.
- A native session's own summaries are accounted for with its completed
  replies, not sent back as unseen messages. Rebuilt or switched sessions
  still receive the active branch's summaries.
- File lists cover the checkpointable local working folder only. Excluded
  files, remote computers and failed/timed-out captures are not represented.
- File capture has a three-second budget and is cancelled on expiry. The
  workspace remains claimed until capture settles; late results may only
  update their original, still-active message and task generation.
- `full` means every recorded tool row delivered an untruncated result through
  the hook. It does not mean tests passed. Otherwise evidence is `preview` or
  `none`. Hooks have their own four-second timeout, a bounded input and no
  redirects. `OMB_HOOKS=0` disables them.
- Desktop chips and native mobile presentation need their respective renderer
  checks. These server tests do not prove layout or a real provider's hooks.
