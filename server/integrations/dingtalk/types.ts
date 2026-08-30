export interface DingTalkSender {
  senderCorpId?: string;
  senderStaffId?: string;
  senderId: string;
  displayName: string;
}

/** Transport delivery and DingTalk business event identifiers are distinct. */
export interface DingTalkInboundMessage {
  sourceEventId: string;
  transportMessageId: string;
  conversationId: string;
  addressedToBot: boolean;
  text: string;
  replyToSourceEventId?: string;
  sender: DingTalkSender;
  receivedAt?: number;
}

export interface DingTalkSessionReplyChannel {
  sourceEventId: string;
  webhookUrl: string;
  expiresAt: number;
}

export interface DingTalkCardAction {
  /** Stream delivery identity, used by the durable sink for idempotency. */
  transportEventId: string;
  transportMessageId: string;
  actionToken: string;
  sender: DingTalkSender;
  reason?: string;
  receivedAt: number;
  origin?: "card" | "text";
}

export type DingTalkOwnerTextCommandName =
  | "status"
  | "pause"
  | "resume"
  | "retry"
  | "cancel"
  | "refresh_approval";

export interface DingTalkOwnerTextCommand {
  transportEventId: string;
  transportMessageId: string;
  command: DingTalkOwnerTextCommandName;
  workItemId: string;
  sender: DingTalkSender;
  receivedAt: number;
}

export interface DingTalkOwnerTextCommandOutcome {
  allowed: boolean;
  duplicate: boolean;
  command: DingTalkOwnerTextCommandName;
  workItemId: string;
  reason: string;
}

export interface DingTalkStreamEnvelope {
  type: string;
  headers: {
    messageId: string;
    topic: string;
    eventId?: string;
    time?: string;
  };
  data: string;
}

export interface NormalizedDingTalkMessage {
  message: DingTalkInboundMessage;
  replyChannel?: DingTalkSessionReplyChannel;
  contentKind: "text" | "rich_text" | "unsupported";
  payloadHash: string;
}
