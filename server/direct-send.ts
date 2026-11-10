// What a one-to-one send carries into acceptDirectSend (server/index.ts), and the receipt it answers with.
import type { FollowUp } from "../shared/follow-up.ts";
import type { ResolvedSender, SteerQueueReason } from "../shared/wire.ts";
import type { DataContext } from "./data-context.ts";
import type { Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";
import type { LiveSendResult } from "./live-call-controller.ts";

export interface DirectSendInput {
  botId: string;
  threadId: string;
  text: string;
  sendId?: string;
  replyTo?: Message;
  sender?: ResolvedSender;
  trigger: UsageTrigger;
  via?: "call";
  callId?: string;
  requireSteerRequestId?: boolean;
  dataContext?: DataContext;
  personPresent: boolean;
  app?: { context?: string; fromApp?: Message["fromApp"]; pointed?: Message["pointed"] };
  /** Sent while the bot works: steer into the running turn, queue after it, or restart it (shared/follow-up.ts). */
  followUp?: FollowUp;
  /** Bot ids the person picked from the @ list. */
  mentions?: string[];
  /** The sender is the team's Owner or an Admin, so a typed stop may end someone else's run. */
  admin?: boolean;
}

export type DirectSendReceipt =
  | { ok: true; threadId: string; message: Message; steered?: true; requestMessageId?: string }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason; why?: string };

export function liveSendReceipt(receipt: DirectSendReceipt): LiveSendResult {
  if ("queued" in receipt) return { kind: "queued", queueId: receipt.queueId };
  return { kind: receipt.steered ? "steered" : "started", messageId: receipt.message.id,
    ...(receipt.steered ? { requestMessageId: receipt.requestMessageId } : {}),
  };
}
