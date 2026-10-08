// What the bot did on one Live call, for the call's record in the chat.
// A call's messages are the user lines carrying its id (each spoken request)
// and every message whose requestMessageId points at one of them: the
// activity, cards and answers of the turns those requests started. A typed
// line carries no call id, so a turn it started is never listed, even while
// a call runs. The whole transcript is read, not only what comes before the
// row: a turn still running at hang-up keeps adding steps.
// A line steered into a running turn starts no turn of its own: that turn
// keeps pointing at the request it began with. So a typed line steered into
// a call's turn is listed with the call, and a spoken line steered into a
// typed request's turn (or into another call's) is not listed with its own.
import type { Message } from "@/state/store";
import { isStatusActivity } from "@/lib/activity-runs";
import { failedTurnCause } from "../../shared/failed-turn";

export type CallRecordLine =
  | { kind: "step"; id: string; tool: NonNullable<Message["tool"]> }
  | { kind: "approval"; id: string; card: NonNullable<Message["card"]> };

/** A call's steps and approval cards, in transcript order. Status rows,
 * failed-turn rows, chips that link to another conversation and question
 * cards are not work the bot did, so they are left out. */
export function callRecordLines(transcript: readonly Message[], callId: string): CallRecordLine[] {
  const requests = new Set<string>();
  for (const message of transcript) {
    if (message.role === "user" && message.callId === callId) requests.add(message.id);
  }
  if (requests.size === 0) return [];
  const lines: CallRecordLine[] = [];
  for (const message of transcript) {
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    const { tool, card } = message;
    if (message.kind === "activity" && tool && !message.comm && !message.threadRef &&
      !isStatusActivity(message) && failedTurnCause(tool.name) === null) {
      lines.push({ kind: "step", id: message.id, tool });
    } else if (message.kind === "options" && card?.requestId && card.tool && !card.questionRequest) {
      lines.push({ kind: "approval", id: message.id, card });
    }
  }
  return lines;
}
