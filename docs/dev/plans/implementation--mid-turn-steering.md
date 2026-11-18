# Implementation plan: course-correct a bot mid-response

Status: **implemented; awaiting user review (2026-11-18)**

## Objective

Let the user send a message while a bot is working and have the bot take it into account in the same turn, instead of waiting for the turn to finish. Works in DMs and rooms. Out of scope: editing an earlier message mid-turn, and steering scheduled runs.

## Current state

- **DMs:** while a bot is busy the composer holds the message locally ("Enter queues your message") and sends it when the turn ends (`src/components/Composer.tsx`, `src/lib/useQueuedMessageSender.ts`).
- **Rooms:** as of the cut-in change, a message sent mid-turn goes to the server, runs right after the current turn, and stops any pending bot-to-bot handoff. The running bot still doesn't see it until its turn ends.
- `ProviderAdapter` has `sendTurn` and `interruptTurn` only (`server/contracts.ts:138`).

## What each AI app supports (checked 2026-11-18)

| Driver | Mid-turn input | How |
|---|---|---|
| Claude (`server/drivers/claude.ts`) | Yes | Already runs `--input-format stream-json`, but closes stdin after the prompt. A user message written to stdin mid-turn is picked up at the next step. Tested with Claude Code 2.1.312: `sleep 5` running, steer sent at 7 s, the model dropped the remaining commands and answered within the same turn (one `result`). |
| Codex (`server/drivers/codex.ts`) | Yes | app-server `turn/steer` `{ threadId, expectedTurnId, input }` (codex-cli 0.164.0 schema). |
| Grok / other ACP (`server/drivers/acp`) | No | ACP has no mid-prompt input. Fallback below. |
| Antigravity, built-in | No | Fallback below. |

## Proposed changes

1. **Adapter capability** — add optional `steerTurn(threadId, text, attachments?) => Promise<void>` to `ProviderAdapter`.
   - Claude: keep stdin open for the life of the turn and close it on `result`/exit; `steerTurn` writes a stream-json user message.
   - Codex: track the active `turnId` per thread; `steerTurn` sends `turn/steer`.
2. **Fallback for drivers without it** — "stop and redirect": interrupt the turn, then start a new turn whose prompt is the user's new message. The conversation keeps the partial reply, so the bot can see what it had done.
3. **Server routes** — `POST /api/bots/:id/messages` and `/api/groups/:id/messages` gain `steer: true`. When the target is busy:
   - append the user message to the transcript immediately (marked `steered: true`), so it shows where it was sent;
   - DMs: steer the running turn; rooms: steer the busy bot when the message mentions no one or mentions that bot. A message that mentions only other bots keeps the cut-in behaviour (runs next).
   - If steering fails (turn ended in the meantime, driver error), fall back to sending it as the next turn, never dropping it.
4. **Composer** — while a bot is working, **Enter steers** and **⌥Enter queues** (sends after the turn, today's behaviour). The send button shows which one will happen; placeholder: "Ada is working — Enter to steer, ⌥Enter to queue". The current queued-message chip stays for the queue path.
5. **Transcript** — a steered message renders as a normal user bubble with a small "sent mid-turn" label, placed after the text the bot had produced so far.

## Risks

- **Claude timing:** the message lands at the next step, not instantly; during one long command it waits for that command to end. The label should say "picked up at the next step".
- **Codex `expectedTurnId` races:** if the turn completes between the click and the request, the server falls back to a new turn (point 3).
- **Fallback cost:** stop-and-redirect discards work in progress for Grok/ACP bots; the button title says so for those bots.

## Verification

- Driver unit tests: Claude stdin stays open and closes on result; Codex sends `turn/steer` with the live turn id; ACP reports no steering support.
- Server tests with fake CLIs: DM steer, room steer of the busy bot, room message to another bot keeps cut-in, steer after the turn ended becomes a new turn.
- Desktop QA on an isolated instance: steer a real Claude bot mid-command (cheapest model), and a Codex bot; queue with ⌥Enter still waits.

## Implementation notes

- Steering uses text plus the existing attachment file context; it does not resend base64 attachment data to the native stdin/RPC surface.
- Corrections are persisted once before delivery and receive pending/native/restarted/queued/cancelled/failed states. Native refusals wait for the old turn, then deliver the saved message once. Stop cancels pending delivery.
- Streamed text is checkpointed before the correction and on interrupted completion; the final whole-message event contributes only its unsaved remainder.
- Room fallback preserves other saved user requests. Mentions addressing only other bots retain the room cut-in path.
- Configured per-instance environment overrides are now honored by Claude and Codex turn processes, as ACP already does; API-key billing variables are still stripped afterwards.
- UI verification used an isolated Electron renderer after Studio Preview failed to initialize and marked its session stopped. Alt+Enter queue, Enter fallback, tooltip and transcript label passed. A real Codex run accepted steering during `sleep 20` and answered `CORRECTED` with one start/completion. Live Claude was blocked by the account's five-hour limit; its native protocol and server tests pass against the fake CLI.
