// Check before done sends an answer back for fixing with a line that carries `checkRound`; the fixed answer follows it.
import type { WireMessage as Message } from "../../shared/wire.ts";

/** The bot's own answer lines a later check sent back for fixing, by message id, with that check's round: each answer
 * line since the person last wrote, up to a line with `checkRound`, once a fixed answer follows that line. An answer
 * whose fix wrote nothing (it failed or was stopped) is the one the person gets, so it stays whole. */
export function earlierAnswers(messages: readonly Message[]): ReadonlyMap<string, number> {
  const earlier = new Map<string, number>();
  let answer: string[] = [], sentBack: { ids: string[]; round: number } | null = null;
  for (const message of messages) {
    if (message.role === "user") {
      answer = [];
      sentBack = null;
    } else if (message.checkRound) {
      sentBack = { ids: answer, round: message.checkRound };
      answer = [];
    } else if (message.role === "bot" && message.kind === "text" && !message.from && message.text?.trim()) {
      for (const id of sentBack?.ids ?? []) earlier.set(id, sentBack!.round);
      sentBack = null;
      answer.push(message.id);
    }
  }
  return earlier;
}
