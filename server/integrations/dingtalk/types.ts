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
