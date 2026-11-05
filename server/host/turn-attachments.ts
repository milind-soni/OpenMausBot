// The files a turn parked while it ran (generated images, recorded voice notes), and what becomes of them when it settles.
import type { Message } from "../store.ts";

export type ParkedTurnAttachment = NonNullable<Message["attachments"]>[number];

/** A turn the person stopped loses the voice notes it recorded; every other turn, a failed one included, keeps all its
 * files. A note's words stay on it as its transcript, redacted. */
export function settleParkedFiles(
  parked: readonly ParkedTurnAttachment[],
  stopped: boolean,
  redact: (text: string) => string,
): { land: ParkedTurnAttachment[]; discard: ParkedTurnAttachment[] } {
  const land: ParkedTurnAttachment[] = [];
  const discard: ParkedTurnAttachment[] = [];
  for (const file of parked) {
    if (file.kind !== "audio") land.push(file);
    else if (stopped) discard.push(file);
    else land.push({ kind: "audio", path: file.path, mime: file.mime, ...(file.text?.trim() ? { text: redact(file.text.trim()) } : {}) });
  }
  return { land, discard };
}
