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

## Hooks that do not hold the engine

Claude Code waits for a synchronous hook before it hands a tool's result back
to the model, and each hook starts the helper as its own process (the whole
Electron binary in the desktop app). Only two replies change what the engine
does: the hint for a timed-out Bash call (`PostToolUseFailure`, matcher
`Bash`) and the digests re-sent after a compaction (`SessionStart`, matcher
`compact`). `PostToolUse` only saves the full output, so it runs `async` with
a 60 s timeout; there is no `Stop` hook. A `PostToolUse` can land after its
turn has ended. For 60 s after that, the ended turn's hook token is honoured
for one thing only: saving the full output of that turn's own tool calls not
yet saved, each once. The digest is written at the turn's end and says "from
tool previews" until those outputs complete the turn's evidence; then it is
marked full again. `server/hooks.e2e.test.ts` plays this with
`FAKE_CLAUDE_HOOKS_AFTER_TURN_MS`.

To see the difference with the real CLI, run `claude -p` in an empty folder
with `--settings` pointing at a file holding
`{ "hooks": claudeHookSettings(helperPath) }` and
`ELECTRON_RUN_AS_NODE=1`, ask for a few Bash calls, and compare each
`tool_use` to its `tool_result` in the stream-json output against the same run
with every hook synchronous.

## Shell calls that hit their time limit

Claude Code stops a Bash call after 2 minutes unless the call passes a larger
`timeout` (the driver pins the cap at 600000 ms through `BASH_MAX_TIMEOUT_MS`;
native background tasks stay off). Engines with a shell get a "Long-running
commands" prompt section, and a timed-out call's `PostToolUseFailure` hook gets
`additionalContext` telling the model to rerun with a longer timeout or
detached, or to use `mdfind`/a scoped folder instead of `find /`.

```sh
pnpm exec vitest run server/shell-timeout-hint.test.ts server/hooks.e2e.test.ts
FAKE_CLAUDE_HOOKS=1 FAKE_CLAUDE_TOOL_CALLS='[{"name":"Bash","input":{"command":"find / -name x"},"ok":false,"output":"Exit code 143\nCommand timed out after 2m 0s"}]' \
  node --experimental-strip-types scripts/control-omb.ts launch
```

Send one direct turn and one channel turn, then wait for each to settle. The fake echoes each
failure hook's context into its reply, so the transcript shows the hint. The
fixture's `fake-claude-dump.json` shows the prompt section, `BASH_MAX_TIMEOUT_MS`
and the `PostToolUseFailure` hook registration. Last exercised 2026-10-13
(direct and channel turns).

## Replies with no recorded work

Android and desktop omit empty receipts. Both mobile parsers stop at the
trailing `reply:` field, including when the reply contains ` · ` separators.
Recorded tools, files, memory changes, truncation notices and unknown work
sections remain visible; the stored digest is not deleted.

Regression checks:

```sh
pnpm exec vitest run src/components/DigestChip.test.ts
(cd ios && swift test --filter RoutineRunDigestTests)
(cd android && ./gradlew :core:test --tests '*TurnDigestTest' --tests '*ChatPreferencesTest' :app:testDebugUnitTest --tests '*TranscriptPresentationTest')
```

For the real desktop renderer, follow [the chat UI recipe](chat-ui.md), launching
with `--tool-calls '[]'` and setting `features.showToolCalls=true`. Send `hello`
and wait for settlement: the reply remains visible and the transcript contains
no `[data-testid="digest-chip"]`. Repeat in a new disposable fixture with
`--tool-calls '[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]'`:
the work receipt must now remain visible. Keep both wait results and DOM
snapshots. Android's transcript suite opens a useful receipt after checking
that the empty receipt is absent, and saves `digest-only-recorded-work.png`.

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
