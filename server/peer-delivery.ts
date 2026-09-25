// Delivery receipts for bot-to-bot messages: what actually happened to a
// send the moment the coordination/delegation tool returned, one receipt
// per recipient. The outcomes are the bot-facing half of the same honesty
// discipline SteerOutcome applies to steering — a tri-state that can always
// be answered truthfully, where an indeterminate send reads "queued", never
// "delivered":
//
//   queued   — accepted into a durable lane; the recipient's turn has not
//              started, so nothing has been delivered yet
//   injected — the recipient's turn started with this message (it may still
//              be running, or it may have run and failed)
//   failed   — not delivered; the detail says why
//
// The rule that overrides every other consideration: never report delivery
// that did not happen. A failed live hand-off may stay buffered for a later
// drain, but its receipt stays failed.

import { peerName } from "./peer-roster.ts";

export type PeerDeliveryOutcome = "queued" | "injected" | "failed";

export interface PeerDeliveryReceipt {
  /** The recipient's bot id — the address the caller actually used. */
  botId: string;
  /** The recipient's name, when the server knows it. */
  botName?: string;
  outcome: PeerDeliveryOutcome;
  /** One plain line saying why. Composed by the endpoint that produced the
   * receipt; flattened and clipped here before it reaches a model. */
  detail: string;
  /** Claim ticket for the lane that provides one (delegations). */
  taskId?: string;
  /** The coordination node, for coordinate_bots sends. */
  requestId?: string;
}

// Detail lines are built from harness error text that can carry
// peer- or provider-authored content, so they get the same flatten-and-clip
// discipline as a roster entry (peer-roster.ts) rather than trust the
// sender of the failure. Written as a scan for the same reason the linter
// refuses a control-character literal.
const DETAIL_MAX = 200;
const oneLine = (value: string): string => {
  let flattened = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const breaksOut =
      code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    flattened += breaksOut ? " " : value[i];
  }
  return flattened.replace(/\s+/g, " ").trim();
};

const clip = (value: string): string => {
  const flat = oneLine(value);
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
};

/** Build a receipt with the detail flattened onto one clipped line. */
export function peerDeliveryReceipt(receipt: PeerDeliveryReceipt): PeerDeliveryReceipt {
  return {
    botId: receipt.botId,
    ...(receipt.botName ? { botName: receipt.botName } : {}),
    outcome: receipt.outcome,
    detail: clip(receipt.detail) || "no detail recorded",
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
  };
}

const named = (receipt: PeerDeliveryReceipt): string =>
  peerName(receipt.botName ?? "") || peerName(receipt.botId) || "teammate";

/** Render receipts as the tool-result prose a sender reads. One receipt
 * becomes a single "Delivery to …" line; several become a fenced list with
 * one line per recipient, in the order the caller addressed them. An empty
 * list renders nothing, so callers can append unconditionally. */
export function renderPeerDeliveryReceipts(receipts: readonly PeerDeliveryReceipt[]): string {
  if (!receipts.length) return "";
  const line = (receipt: PeerDeliveryReceipt) => `${named(receipt)}: ${receipt.outcome} — ${receipt.detail}`;
  if (receipts.length === 1) return `Delivery to ${line(receipts[0]!)}`;
  return ["Delivery receipts:", ...receipts.map(receipt => `- ${line(receipt)}`)].join("\n");
}
