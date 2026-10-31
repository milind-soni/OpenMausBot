/**
 * Follows Hermes Agent's desktop group chat (MIT): the newest assistant
 * message is the reply, and an empty or "(pass)" reply is no reply.
 */
import type { WireMessage as Message } from "../shared/wire.ts";
import { serverLine } from "./server-lines.ts";

export function isPassText(text: string | undefined): boolean {
  const trimmed = (text ?? "").trim();
  return !trimmed || /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

export function roomTurnReply(texts: readonly string[]): string {
  const last = texts.at(-1)?.trim() ?? "";
  return isPassText(last) ? "" : last;
}

export function roomTurnNarrationIds(messages: readonly Message[]): Set<string> {
  const settled = new Set<string>();
  for (const message of messages) {
    if (message.role === "bot" && message.kind === "text" && message.turnId && message.turnTerminal) settled.add(message.turnId);
  }
  const narration = new Set<string>();
  for (const message of messages) {
    if (
      message.role === "bot" &&
      message.kind === "text" &&
      message.turnId &&
      !message.turnTerminal &&
      !message.attachments?.length &&
      settled.has(message.turnId)
    ) narration.add(message.id);
  }
  return narration;
}

export const ROOM_SUMMARY_REASK =
  "Your last turn in this room ended without a final message to the room. Reply now with one short message (1–3 lines): your result, or that you could not finish and why. Do not start new work.";

export function finishedWithoutSummaryLine(name: string, reasking: boolean, language?: string): string {
  return serverLine(language, reasking ? "server.rooms.finishedNoSummaryAsking" : "server.rooms.finishedNoSummary", { bot: name });
}
