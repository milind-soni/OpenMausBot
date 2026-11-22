// Receipts for bot-to-bot sends: queued (not started), injected (the recipient's turn started with it) or failed. Never report a delivery that did not happen.

import { clip, peerName } from "./peer-roster.ts";

export type PeerDeliveryOutcome = "queued" | "injected" | "failed";

export interface PeerDeliveryReceipt {
  botId: string;
  botName?: string;
  outcome: PeerDeliveryOutcome;
  detail: string;
  /** A refusal that only says there is nothing left for this message to do: the bot reads it and finishes, and no turn
   * fails on it. Anything that broke stays absent. */
  instructionOnly?: true;
  taskId?: string;
  requestId?: string;
  threadId?: string;
  /** Its place in a room's line when room jobs there run one at a time. */
  queue?: { position: number; of: number; waitingFor?: string };
}

// Detail can carry peer- or provider-authored text: flattened and clipped like a roster entry.
const DETAIL_MAX = 200;

export function peerDeliveryReceipt(receipt: PeerDeliveryReceipt): PeerDeliveryReceipt {
  return {
    botId: receipt.botId,
    ...(receipt.botName ? { botName: receipt.botName } : {}),
    outcome: receipt.outcome,
    detail: clip(receipt.detail, DETAIL_MAX) || "no detail recorded",
    ...(receipt.instructionOnly ? { instructionOnly: true as const } : {}),
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
    ...(receipt.threadId ? { threadId: receipt.threadId } : {}),
    ...(receipt.queue ? { queue: { position: receipt.queue.position, of: receipt.queue.of,
      ...(receipt.queue.waitingFor ? { waitingFor: clip(receipt.queue.waitingFor, DETAIL_MAX) } : {}) } } : {}),
  };
}

const named = (receipt: PeerDeliveryReceipt): string =>
  peerName(receipt.botName ?? "") || peerName(receipt.botId) || "teammate";

/** The coordinate call refused only to say there is nothing left for its message to do: it had a refusal, and every
 * refusal's own words came from a receipt that said so. One part's instruction to finish is not the whole call's
 * verdict, and a receipt that said anything else keeps the call a failure. */
export function refusalsOnlyInstructions(refused: readonly string[], receipts: readonly PeerDeliveryReceipt[]): boolean {
  const instructed = receipts.filter((receipt) => receipt.outcome === "failed" && receipt.instructionOnly === true).map((receipt) => receipt.detail);
  return refused.length > 0 && refused.every((said) => instructed.includes(said));
}

/** A bot's name as a coordinate_bots target is matched: no leading @, dashes and underscores as spaces, any case. */
export const foldName = (value: string): string => value.replace(/^@/u, "").replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();

export type CoordinateResult = { status: number; body: Record<string, unknown> };

/** A coordinate_bots call that sent some of its targets elsewhere (another place, another server) answers once for all:
 * what went elsewhere, then the targets still `here` handed on as before (`local`). `message` is what a delivery
 * elsewhere tells the bot. */
export async function withTargetsHere<Call extends { botIds: string[] }>(call: Call, here: readonly string[], sent: { receipts: PeerDeliveryReceipt[]; refused: string[]; message: string },
  local: (call: Call) => Promise<CoordinateResult>): Promise<CoordinateResult> {
  const { receipts, refused } = sent;
  const delivered = refused.length < receipts.length;
  const mine = delivered ? sent.message : "";
  if (here.length === 0) return { status: delivered ? 200 : 409, body: { receipts, ...(delivered ? { message: mine } : { error: refused.join("; ") }) } };
  const rest = await local({ ...call, botIds: [...here] });
  const theirs = Array.isArray(rest.body.receipts) ? rest.body.receipts as PeerDeliveryReceipt[] : [];
  const ok = delivered || rest.status === 200;
  // The local part's error and not-sent list are rebuilt below, so a success never carries its error.
  const { instructionOnly: localInstructionOnly, error: localError, notSent: localNotSent, ...restBody } = rest.body;
  const errors = [...refused, ...(typeof localError === "string" ? [localError] : [])];
  const notSent = [...errors, ...(typeof localNotSent === "string" ? [localNotSent] : [])];
  // Instruction-only is the whole call's verdict: nothing was delivered anywhere and no refusal elsewhere is a real
  // failure. One genuine refusal, or a delivery, keeps this a failed call however the local part answered.
  const instructionOnly = !ok && refused.length === 0 && localInstructionOnly === true;
  return { status: ok ? 200 : rest.status, body: { ...restBody, receipts: [...receipts, ...theirs],
    ...(ok ? { message: [mine, rest.body.message].filter(Boolean).join(" "), ...(notSent.length ? { notSent: notSent.join("; ") } : {}) } : { error: errors.join("; ") }),
    ...(instructionOnly ? { instructionOnly: true } : {}) } };
}

export function renderPeerDeliveryReceipts(receipts: readonly PeerDeliveryReceipt[]): string {
  if (!receipts.length) return "";
  const line = (receipt: PeerDeliveryReceipt) => `${named(receipt)}: ${receipt.outcome} — ${receipt.detail}`;
  if (receipts.length === 1) return `Delivery to ${line(receipts[0]!)}`;
  return ["Delivery receipts:", ...receipts.map(receipt => `- ${line(receipt)}`)].join("\n");
}
