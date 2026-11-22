// The lines the desktop app's own window sent, noted at the one route that can tell. In the desktop app a change reaches
// the server only with the window's private capability (request-auth.ts DESKTOP_OWNER_HEADER), so a bot's shell on this
// machine can never send such a line. Bound to the thread and the words, like typed-sends.ts, so a bot that reads a
// sendId in a transcript cannot lend it to words of its own. In memory on purpose: after a restart a line is nobody's
// again, which only takes the owner's lent computers away.
import { createHash } from "node:crypto";

import { createPhoneSends } from "./phones/sends.ts";

const sends = createPhoneSends();
const proof = (threadId: string, sendId: string, text: string): string =>
  createHash("sha256").update(JSON.stringify(["own-window", threadId, sendId, text])).digest("base64");

export function noteOwnWindowSend(threadId: string, sendId: string, text: string): void {
  sends.note(proof(threadId, sendId, text));
}

type Line = { role?: string; text?: string; sendId?: string; sender?: unknown; peerAsk?: unknown; relayed?: boolean; via?: string; aside?: unknown };

/** A person's line the desktop app's own window sent: no signed-in sender, relay, app or bot wrote it. */
export function ownWindowLine(threadId: string, line: Line | undefined): boolean {
  if (!line || line.role !== "user" || line.sender || line.peerAsk || line.relayed || line.via !== undefined || line.aside) return false;
  return line.sendId !== undefined && line.text !== undefined && sends.has(proof(threadId, line.sendId, line.text));
}
