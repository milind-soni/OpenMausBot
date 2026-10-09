// What the bot did on one Live call, for the call's record in the chat.
// A call's messages are the user lines carrying its id (each spoken request)
// and every message whose requestMessageId points at one of them: the
// activity, cards and answers of the turns those requests started. A typed
// line carries no call id, so a turn it started is never listed, even while
// a call runs. The whole transcript is read, not only what comes before the
// row: a turn still running at hang-up keeps adding steps.
// A line steered into a running turn starts no turn of its own: that turn
// keeps pointing at the request it began with. So with a typed line
// steered into a call's turn, the turn's work is still listed with the
// call; with a spoken line steered into a typed request's turn (or into
// another call's), none of that turn's work is listed with its own call.
import type { Message } from "@/state/store";
import { isToolStep } from "@/lib/activity-runs";

export type CallRecordLine =
  | { kind: "step"; id: string; tool: NonNullable<Message["tool"]> }
  | { kind: "approval"; id: string; card: NonNullable<Message["card"]> };

/** A call's steps and approval cards, in transcript order. A step is a tool
 * the provider ran, which is what carries an item id. Status rows, failed-turn
 * rows, chips that link to another conversation, the harness's own chips
 * (the receipt of an automatic approval, a notice, a rejected action, a retry)
 * and question cards are not work the bot did, so they are left out. */
export function callRecordLines(transcript: readonly Message[], callId: string): CallRecordLine[] {
  const requests = new Set<string>();
  for (const message of transcript) {
    if (message.role === "user" && message.callId === callId) requests.add(message.id);
  }
  if (requests.size === 0) return [];
  const lines: CallRecordLine[] = [];
  for (const message of transcript) {
    if (!message.requestMessageId || !requests.has(message.requestMessageId)) continue;
    const { card } = message;
    if (isToolStep(message)) {
      // The harness writes chips of its own inside a turn. Each looks like a
      // step to the chat's fold, but none has a provider item behind it:
      // listing them would show an auto-approved action twice, or a note as
      // work.
      if (message.tool.itemId !== undefined) lines.push({ kind: "step", id: message.id, tool: message.tool });
    } else if (message.kind === "options" && card?.requestId && card.tool && !card.questionRequest) {
      lines.push({ kind: "approval", id: message.id, card });
    }
  }
  return lines;
}

/** Whether a call's record may be missing lines because older messages are
 * not loaded: some remain on the server (`hasMore`), and the oldest message
 * loaded came after the call began, so a spoken request of the call, and the
 * work it started, may sit before it. Loading earlier messages settles it. */
export function callRecordIsPartial(transcript: readonly Message[], call: { startedAt: number }, hasMore: boolean): boolean {
  const oldest = transcript[0];
  return hasMore && oldest !== undefined && oldest.at > call.startedAt;
}
