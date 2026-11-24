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

const inFlight = new Map<string, number>();

/**
 * A send from the window, known from before it is accepted: the turn it starts may set up (and read its line) before
 * the send answers. The answer settles it: kept for a send that was accepted, gone for one that was refused.
 */
export function ownWindowSendStarting(threadId: string, sendId: string, text: string): (accepted: boolean) => void {
  const key = proof(threadId, sendId, text);
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let settled = false;
  return (accepted) => {
    if (settled) return;
    settled = true;
    const left = inFlight.get(key)! - 1;
    if (left) inFlight.set(key, left);
    else inFlight.delete(key);
    if (accepted) sends.note(key);
  };
}

type Line = { role?: string; text?: string; sendId?: string; sender?: unknown; peerAsk?: unknown; relayed?: boolean; via?: string; aside?: unknown };

/** A person's line the desktop app's own window sent: no signed-in sender, relay, app or bot wrote it. */
export function ownWindowLine(threadId: string, line: Line | undefined): boolean {
  if (!line || line.role !== "user" || line.sender || line.peerAsk || line.relayed || line.via !== undefined || line.aside) return false;
  if (line.sendId === undefined || line.text === undefined) return false;
  const key = proof(threadId, line.sendId, line.text);
  return sends.has(key) || inFlight.has(key);
}
