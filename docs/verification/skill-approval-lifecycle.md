# Learned-skill approval lifecycle

Run the existing disposable Electron/server harness with its skill UI recipe:

```sh
pnpm exec electron scripts/smoke-approval-modes.cjs --skill-ui-only
```

The harness creates a temporary home, runs the real server with fake provider
CLIs, and mounts the real ChatView, task picker, composer and StoreProvider in
two hidden Electron windows. It never touches the running app or user data.
No skill is enabled, no real provider is called, and no cleanup instruction
from the reported screenshot is executed.

The recipe asserts:

1. Clicking **Deny** settles a staged skill card in both windows.
2. Deny also works when the temporary staged record has already disappeared.
3. A denied skill name can be proposed again; it is not silently reserved.
4. Deleting the active thread through the real task picker removes its pending
   card in both windows. The second window receives only server events, not
   the delete request's response.
5. The surviving thread retains its exact messages; the bot remains present.
6. The staged skill is removed, and a new message sent through the composer
   receives a fake-provider reply in both windows without reopening the app.

Screenshots and assertion results are saved in
`.omb-scratch/verify-evidence/skill-approval/`. Windows, server and temporary
data are cleaned up after the run; the evidence remains.

## Ordering regressions

```sh
pnpm exec vitest run src/state/store.test.ts src/components/ChatView.controls.test.ts src/components/ApprovalCard.test.ts server/skills.test.ts server/independent-task-store.test.ts
pnpm exec vitest run server/index.test.ts -t 'only enables the exact learned-skill'
pnpm typecheck
pnpm lint
```

The original failure is a slim bot event arriving before its full replacement
transcript. Previously this changed the thread ID but retained the deleted
thread's messages, including its pending approval. Subsequent snapshots were
ignored because the thread ID now matched, and Deny targeted the wrong thread.

The state tests assert immediate removal of the old transcript, a disabled
composer until its replacement arrives, full-snapshot-first ordering, replay
of intervening events, rejection of old buffered approval patches, and no
rollback from duplicate responses or navigation to another thread.

This proves the reported lifecycle with real server/renderer state and a
synthetic skill. It does not prove provider-specific tool behavior or recover
a bot that the user has already deleted.
