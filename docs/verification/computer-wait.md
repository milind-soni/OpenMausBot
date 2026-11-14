# Waiting for a shared computer

Run the real-server fixture in an isolated home, with a local Boat API stub:

```sh
pnpm exec vitest run server/index.test.ts -t 'shares one team computer|dispatches the conversation.s pinned computer|blocks bot-scoped Boat lifecycle'
pnpm exec vitest run server/index.test.ts -t 'queues computer waiters in arrival order'
pnpm exec vitest run server/index.test.ts -t 'parks the turn at the wait ceiling|routes a goal run around a member parked'
pnpm exec vitest run server/runtime-roots.e2e.test.ts server/room-roots.e2e.test.ts
pnpm exec vitest run server/turn-resources.test.ts server/group-local-vm.e2e.test.ts server/shared-computers.e2e.test.ts
pnpm exec vitest run server/managed-desktop-cleanup.test.ts
```

The shared-team-computer case proves:

- A first turn starts on the Boat stub; a second thread under the same bot
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

The park-and-resume cases prove:

- A turn that reaches the computer wait ceiling settles parked, not failed:
  its root in the runtime (docs/runtime-contract.md §2, §6) is queued to
  continue in place, the chip names the holder, and the same root continues
  on its own when the computer frees, opening with the computer line. A room
  member's turn parks and continues exactly the same way, because it is a
  root too (docs/runtime-contract.md §10 PR 5): one row, no hand-off rows,
  one more execution when the seat frees.
- Stop while parked cancels that root, in a direct task and in a room alike:
  freeing the seat afterwards starts nothing, and a newer message in the same
  thread replaces a parked wait rather than waking it.
- A goal run routes around a member parked at the ceiling: the parked step is
  a root that ended with its park, never queued to continue, so freeing the
  seat runs it no second time; the lead finishes the goal with the park as
  reassignment data. (`server/room-roots.e2e.test.ts` proves the room cases
  against the scripted engine; `server/runtime-roots.e2e.test.ts` the direct
  ones.)
- Nothing waits outside the runtime: the card-resume lanes and the room
  re-run queue are gone. A parked root waits through the runtime's admission
  (the host's busy hook holds it until the seat frees).

Waiting is bounded by the computer wait ceiling (`OMB_COMPUTER_WAIT_MAX_MS`,
30 minutes by default). At the ceiling the turn parks instead of failing, and
its root continues on its own when the computer is free. Cancellation checks
the exact turn generation.
Desktop ownership still spans a turn so screenshot/click sequences cannot
interleave. This is automatic waiting, not simultaneous control of one screen.

These fixtures do not contact Boat or operate the user's desktop. They verify
server behavior and transcript state, not visual rendering or a live Boat.
