// What a one-to-one send carries into acceptDirectSend (server/index.ts), and the receipt it answers with.
import type { FollowUp } from "../shared/follow-up.ts";
import type { ResolvedSender, SteerQueueReason } from "../shared/wire.ts";
import type { DataContext } from "./data-context.ts";
import type { Message } from "./store.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

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
  dataContext?: DataContext;
  personPresent: boolean;
  app?: { context?: string; fromApp?: Message["fromApp"]; pointed?: Message["pointed"] };
  /** Sent while the bot works: steer into the running turn, queue after it, or restart it (shared/follow-up.ts). */
  followUp?: FollowUp;
}

export type DirectSendReceipt =
  | { ok: true; threadId: string; message: Message; steered?: true }
  | { ok: true; queued: true; queueId: string; threadId: string; reason?: SteerQueueReason };
