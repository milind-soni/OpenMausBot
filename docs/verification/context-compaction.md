# Harness-owned compaction (long threads)

## Sub-features

- Read the context the next turn will carry from main's per-task reading
  (`usage.context.tokens`, what filled the window on the last model call),
  falling back to the last turn's input, then to a byte estimate.
- A budget per task: `context.compactAt` in config.json, a share of the
  model's window below 1 (default 0.6) or an absolute token count; the window
  from the catalog, else a pattern over the model id, else 128,000.
- The budget is held **under the engine's own compaction point** where it has
  one. Claude is handed a fixed `--autocompact` window (200,000 by default)
  while our budget is a share of the MODEL's window, so on a large-window
  model the share lands above it: the CLI would compact first, no record
  would be written, and the thread's history would survive only inside that
  provider session — invisible in the app and lost when the thread moves to
  another model.
- When the last turn crossed the budget, the next direct turn first writes a
  `compaction` record (summary = each folded turn's digest and each request,
  plus a model summary where the engine can draft one) and starts a fresh
  engine session on a budgeted replay: summary, then the last two exchanges
  verbatim, then the new message. Old tool output is never replayed.
- The record keeps what a thread cannot afford to lose twice over: the
  conversation's opening request is pinned (the trim takes from the second
  line forward, never the first), and an EARLIER compaction's summary is
  carried into the new one, capped, so a thread that folds a second time does
  not lose everything before the first fold.
- The manual route `POST /api/bots/:id/tasks/:threadId/compact` resets the
  session the same way.
- `context.autoCompact: false` switches the automatic path off.
- `/api/metrics` counts turns that followed a compaction (`compactions`).

## User path

Nothing to click. A long thread shows a "context compacted" chip and keeps
going; the bot still knows what happened before the chip through the
record's summary.

## Driving it

```sh
pnpm exec vitest run --no-file-parallelism server/context-compaction.e2e.test.ts
pnpm exec vitest run server/context-budget.test.ts server/compaction-summary.test.ts server/context-store.test.ts server/context-config.test.ts
```

The e2e forces a 100,000-token window (`OMB_CONTEXT_WINDOW`) and makes each
fake engine report 200,000 input tokens per turn. On fake Claude, Codex, ACP
and pi: turn 4 is the first with something old enough to fold; it writes
one record by the harness whose first kept message is the second request,
starts a fresh session (the Claude dump's prompt and the ACP echo carry
"[Summary of the conversation before this point"), and the metrics count
it. With `context.autoCompact: false` nothing ever compacts.

By hand: start a standalone harness with a small window and watch a real
thread:

```sh
OMB_CONTEXT_WINDOW=20000 OMB_DATA_DIR=$HOME/.openmausbot-compact OMB_PORT=28831 \
  node --experimental-strip-types server/index.ts
```

Send four or five turns that print a big file; the chip appears on the
turn after the input passes 12,000 tokens, and `/api/metrics` shows
`compactions: 1` for the bot.

## Gotchas

- The engine-side clamp only bites above roughly a 333,000-token window
  (where 0.6 of the window passes Claude's 200,000). The original e2e forces
  a 100,000 window, so it never exercised that case; the "large-window model"
  case does, and fails without the clamp.

- Compaction runs between turns only. A turn that is already running keeps
  its context until it settles.
- Engines that report no usage (some ACP agents) are sized by bytes ÷ 4 of
  the thread's replayable text since the last record.
- The Codex fake needs `FAKE_CODEX_MODE=resume` for any second turn on a
  thread; the default mode refuses `thread/resume`.
