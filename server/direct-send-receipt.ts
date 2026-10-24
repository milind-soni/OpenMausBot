import type { Message } from "./store.ts";
import type { ComposerDelivery } from "../shared/composer-delivery.ts";
import type { SteerQueueReason } from "../shared/wire.ts";
import { acceptedSendMatch } from "./send-idempotency.ts";

export type DirectSendReceipt =
  | { ok: false; uncertain: true; steered?: never; threadId: string; message: Message }
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason };

type QueuedSend = { id: string; text: string; replyToId?: string; composerDelivery?: ComposerDelivery; reason?: SteerQueueReason };
type SendIdentity = { threadId: string; sendId: string; text: string; replyToId?: string; delivery?: ComposerDelivery };

export function existingDirectSendReceipt(messages: Message[], queuedSend: () => QueuedSend | null, input: SendIdentity): DirectSendReceipt | null {
  const { threadId, sendId, text, replyToId, delivery } = input;
  const accepted = acceptedSendMatch(messages, sendId, text, replyToId, undefined, delivery);
  if (accepted.kind === "conflict") throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
  if (accepted.kind === "match") {
    if (accepted.message.steerUncertain) return { ok: false, uncertain: true, threadId, message: accepted.message };
    const canonical = { ok: true as const, threadId, message: accepted.message };
    return accepted.message.steered ? { ...canonical, steered: true as const } : canonical;
  }
  const queued = queuedSend();
  if (!queued) return null;
  if (queued.text !== text || queued.replyToId !== replyToId || JSON.stringify(queued.composerDelivery) !== JSON.stringify(delivery)) {
    throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
  }
  return { ok: true, queued: true, queueId: queued.id, threadId, reason: queued.reason };
}
