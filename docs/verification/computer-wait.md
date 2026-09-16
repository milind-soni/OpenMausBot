# Waiting for a shared computer

Run the real-server fixture in an isolated home, with a local Box API stub:

```sh
pnpm exec vitest run server/index.test.ts -t 'shares one team computer|dispatches the conversation.s pinned computer|blocks bot-scoped Box lifecycle'
pnpm exec vitest run server/turn-resources.test.ts server/group-local-vm.e2e.test.ts server/shared-computers.e2e.test.ts
```

The shared-team-computer case proves:

- A first turn starts on the Box stub; a second thread under the same bot
  waits without sending another provider prompt.
- Stop cancels the waiting thread without interrupting the owner.
- A room waits for that same computer, with a visible activity message.
- Stopping the owner lets the room start automatically, without Retry or
  another user message. The cancelled sibling never starts later.
- Lifecycle changes remain blocked during active computer use, and a missing
  paid computer is still reported rather than silently recreated.

Waiting is bounded by the existing computer/team availability wait window
(30 minutes by default). Cancellation checks the exact turn generation.
Desktop ownership still spans a turn so screenshot/click sequences cannot
interleave. This is automatic waiting, not simultaneous control of one screen.

These fixtures do not contact Box or operate the user's desktop. They verify
server behavior and transcript state, not visual rendering or a live Box.
