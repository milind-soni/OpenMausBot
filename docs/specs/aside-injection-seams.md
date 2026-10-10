# SPEC: per-driver mid-turn seams for the aside lane

Status: ACTIVE. Part of the peer messaging umbrella (#1803); the aside lane
itself (admission, durable queue, receipts, degrade-to-queue) landed with S2
part 1, and this document is the contract every engine's driver follows when
the harness offers it a mid-turn aside.

## What rides the seam

An aside is peer context handed to a thread's RUNNING turn — never a new
turn, never an interruption, never steering authority. The harness queues the
enveloped words durably (message id = dedupe key), then calls
`Adapter.steer(threadId, prompt)` on the running instance when the driver
declares `capabilities.queueing`. On any non-`refused` outcome the harness
appends exactly one transcript line per aside (enveloped text, `aside: true`,
peer provenance, queue-id marker) and retires the durable row; `refused`
returns the words to the queue for the next boundary. `indeterminate` counts
as injected — the words may already be running, and running them twice is the
one mistake this lane must never make.

The transcript record is the durability contract for every seam: an injected
aside may be summarized away by a later compaction (pi does this), but the
record keeps the sender and framing visible to any later reader, and the
queue-id marker makes restart recovery skip already-injected words.

## Per-driver contract

| Driver | Mid-turn seam | Behaviour |
| --- | --- | --- |
| codex | `turn/steer` RPC with `expectedTurnId` | Aside rides the steering channel with the mandatory non-steering envelope; an RPC error from a moved-on turn maps to `refused` (re-queue), a timeout after delivery to `indeterminate`. |
| claude | stdin user message (`writeUser`) | The CLI delivers it before the next model call; a failed write is `refused`; the child is never killed to steer. |
| openai-chat family (openai-compat, grok, mistral, minimax) | owned tool loop | `steer` parks the text on the live turn's entry; the top of the next loop round splices it into the request array as a user message — the one place the array is between rounds, never mid-tool-batch. Parked words stay out of the request array until that boundary. |
| pi | native RPC `{type:"steer", message}` frame | The runtime queues the words into the running agent without aborting the in-flight step and answers `success` after accepting them; `success:false` is an explicit refusal (`refused`), a death/timeout after the frame was written is `indeterminate`. |
| ACP | **none — by protocol, not by omission** | See below. |

## ACP: queue-only by design

ACP has no mid-turn user input. A turn is one `session/prompt` RPC that
streams `session/update` and settles when the RPC result resolves; the only
input the protocol accepts mid-turn is `session/cancel`, which aborts. So an
ACP driver MUST NOT:

- declare `capabilities.queueing` or implement `steer`;
- interrupt-and-reprompt to simulate a seam (that violates the
  non-interrupting invariant the aside lane exists to keep);
- send off-spec frames mid-prompt and call them a seam.

The correct behaviour is the aside lane's built-in degradation: a peer send to
a busy ACP bot is durably queued, the sender receives an honest `queued`
receipt, and the words open the next turn once the running one settles. This
is the same lane a seam-less engine has always used; ACP bots simply never
leave it. Revisit only if the ACP protocol grows a mid-turn input method.

## Adding a seam to a new driver

1. Declare `capabilities.queueing` only when the engine truly accepts user
   input into the RUNNING turn — never to make a UI control appear.
2. Implement `steer` with the full tri-state; `refused` must mean provably
   not delivered, or the harness will replay words that may have run.
3. Deliver parked words at a step boundary the engine already honors; never
   abort, kill, or restart anything to inject them.

