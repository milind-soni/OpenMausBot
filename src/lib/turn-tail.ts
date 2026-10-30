import type { Message } from "@/state/store";

/** Whether the mascot and its status line show under the transcript. They stay for the whole turn: a bot's text in the
 * middle of a turn ("Now I'll build the dashboard") is not its end, and the engine may then spend minutes writing a
 * file before its next step shows. A turn ends across three frames (reply, turn.completed, busy off), so a settled
 * reply at the tail hides them only once the turn has ended; no timer ever does. */
export function showWorkingDots(
  busy: boolean | undefined,
  lastMessage: Message | undefined,
  speakerBotId?: string,
  turnEnded = false,
): boolean {
  if (!busy) return false;
  if (!lastMessage) return true;
  const settledReply = lastMessage.role === "bot" && lastMessage.kind === "text";
  if (!settledReply) return true;
  if (speakerBotId !== undefined && lastMessage.from?.botId !== speakerBotId) return true;
  return !turnEnded;
}

export function awaitedMemberId(
  working: boolean | undefined,
  speakerBotId: string | null | undefined,
  lastMessage: Message | undefined,
): string | undefined {
  if (!working || speakerBotId) return undefined;
  if (lastMessage?.kind !== "activity" || !lastMessage.tool || lastMessage.tool.ok !== undefined) return undefined;
  return lastMessage.from?.botId;
}
