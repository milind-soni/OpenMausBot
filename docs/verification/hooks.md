# Engine hooks (Claude Code)

## Sub-features

- Register one hook helper (`server/hooks/omb-hook.ts`) through the private
  `--settings` file the Claude driver already writes: `PostToolUse`,
  `PreCompact`, `SessionStart`, `Stop`, and `PreToolUse` on `Bash` when the
  bot has `commandFilters: true`.
- `PostToolUse` delivers the full tool result: spilled to
  `<data>/tool-results/<thread>/<tool_use_id>.txt` at 0600, attached to the
  tool's activity row, and the turn's digest reports `hookCoverage: "full"`.
- `PreCompact` and `SessionStart(compact)` record the compaction as chips and
  hand the last two digests back to the engine as plain-text context.
- `PreToolUse` rewrites known noisy shell commands (test runners, installs,
  unbounded `git log`) to a bounded form through `updatedInput`. It never
  blocks and never rewrites what it does not know; every rewrite is counted
  as `filteredCommands` in `/api/metrics`.
- The hook helper always exits 0 within 4 s and presents a per-turn bearer
  read from a file, so a live CLI process keeps working across turns.
- `OMB_HOOKS=0` disables the channel; other engines are unaffected.

## User path

Nothing to click. A Claude bot's tool chips carry the full result behind
"open"; a compaction shows as two chips in the transcript.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/hooks.e2e.test.ts
pnpm exec vitest run server/hooks/filters.test.ts server/hooks/omb-hook.test.ts
```

The e2e runs the fake Claude CLI with `FAKE_CLAUDE_HOOKS=1`, which honours
the settings' hooks block exactly like the real CLI (JSON on stdin, bounded
wait, `updatedInput` applied). It proves: full results spilled and attached,
a forged bearer refused, compaction chips and digest context, the command
filter rewriting `pnpm test` only for the flagged bot, and that `OMB_HOOKS=0`
registers nothing. It also proves the second turn reuses the live CLI
process (finding F1 in the Phase 0 plan).

## Gotchas

- Only the Claude driver has hooks. Codex, pi and the ACP family carry tool
  results through their own protocol (`hookCoverage: "preview"`).
- Flipping `commandFilters` takes effect on the next fresh CLI process, not
  on a process that is already alive for the thread.
- The `PreToolUse` filter is off by default until the bench shows it saves
  tokens (finding F5 in the plan).
