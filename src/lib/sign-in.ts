import type { ComputerHelpRef } from "../../shared/wire";
import { api } from "@/state/store";

/** `note`: the person's own words for the bot, sent with the answer. */
export async function answerSignIn(ref: Pick<ComputerHelpRef, "botId" | "threadId" | "messageId" | "place">, answer: "done" | "cancel", note?: string): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(ref.botId)}/sign-in-cards/${encodeURIComponent(ref.messageId)}/${answer}`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId, ...(note?.trim() ? { note: note.trim() } : {}) }),
  });
  if (ref.place === "vm" || ref.place === "cloud") void window.ogb?.desktopViewer?.close(ref.botId).catch(() => false);
}

export function signInHostIsHere(): boolean {
  return Boolean(window.ogb) && window.ogb?.remoteClient?.active !== true;
}
