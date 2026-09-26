# Waiting for a shared computer

Run the real-server fixture in an isolated home, with a local Box API stub:

```sh
pnpm exec vitest run server/index.test.ts -t 'shares one team computer|dispatches the conversation.s pinned computer|blocks bot-scoped Box lifecycle'
pnpm exec vitest run server/index.test.ts -t 'queues computer waiters in arrival order'
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

The arrival-order case proves:

- Concurrent waiters join one arrival-ordered waitlist per resource and each
  waiting chip names its stable position (1st, 2nd, 3rd) as of arrival.
- Releasing the holder grants the seat to position 1 alone, by the arrival
  text it carries; nobody jumps the released seat.
- The chip's estimate ("recent waits here have taken …") appears only once a
  wait has completed on that resource; chips written before any history
  never gain one retroactively.
- A lazy claim that failed once never blocks the queue: only turns genuinely
  in the exclusive-bind poll loop hold a waitlist slot.

Waiting is bounded by the existing computer/team availability wait window
(30 minutes by default). Cancellation checks the exact turn generation.
Desktop ownership still spans a turn so screenshot/click sequences cannot
interleave. This is automatic waiting, not simultaneous control of one screen.

These fixtures do not contact Box or operate the user's desktop. They verify
server behavior and transcript state, not visual rendering or a live Box.
