import type { Message } from "@/state/store";

/** Whether the transcript tail should show the "working" dots.
 *
 * A turn ends across three server frames: the settled reply (`message`),
 * `turn.completed`, then the bot patch that flips `busy` off. Deriving the
 * dots from `busy && !streaming` alone re-shows them in that window — the
 * reply lands, the dots pop back under it for a beat, then vanish — and the
 * pinned scroll re-anchors around each height change. That grow-shrink-jump
 * is the end-of-stream jitter. A settled reply at the tail means there is
 * nothing to wait for, so the dots stay hidden until something actually new
 * starts: a tool chip, the user's next prompt, or (in rooms) a different
 * speaker taking the floor.
 */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
  /** rooms: the bot currently speaking. A settled reply from a PREVIOUS
   * speaker doesn't cover this one — its dots are real information. */
  speakerBotId?: string,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  const settledReply = lastMessage.role === "bot" && lastMessage.kind === "text";
  if (!settledReply) return true;
  return speakerBotId !== undefined && lastMessage.from?.botId !== speakerBotId;
}

/** rooms: the member the room is waiting on before anyone has the floor.
 *
 * A responder busy in another conversation takes its turn when it frees.
 * Until then the room is working with no speaker, and the newest message is
 * that member's neutral wait chip — an activity with no verdict yet. Naming
 * them keeps the presence row honest; otherwise the room sits silent for as
 * long as the wait lasts. A settled chip (promise kept, or the cap's verdict)
 * or any other tail means nobody is being waited on. */
export function awaitedMemberId(
  working: boolean | undefined,
  speakerBotId: string | null | undefined,
  lastMessage: Message | undefined,
): string | undefined {
  if (!working || speakerBotId) return undefined;
  if (lastMessage?.kind !== "activity" || !lastMessage.tool || lastMessage.tool.ok !== undefined) return undefined;
  return lastMessage.from?.botId;
}
