export interface InkboxResource {
  channel: "email" | "imessage" | "sms" | "calls" | "slack" | "a2a" | "whatsapp";
  status: "ready" | "needs_setup" | "unavailable" | "error";
  address?: string;
  reason: string;
}
/** Inert provider lookup coordinates, never destinations or authorization. */
export interface InkboxDeliveryReference {
  channel: "text" | "email" | "slack" | "calls" | "a2a";
  messageId?: string;
  mailboxId?: string;
  emailAddress?: string;
  rfcMessageId?: string;
  threadId?: string;
  phoneNumberId?: string;
  conversationId?: string;
  connectionId?: string;
  workspaceId?: string;
  messageTs?: string;
  threadTs?: string;
  callId?: string;
  taskId?: string;
  contextId?: string;
}
export interface InkboxDeliveryPreview {
  reference?: InkboxDeliveryReference;
  previewState?: "complete" | "truncated" | "unavailable";
  previewNotice?: string;
}
/** Public settings contract. Transport credentials never cross this boundary. */
export interface InkboxSetupSnapshot {
  available: boolean;
  resources?: InkboxResource[];
  capabilitiesAvailable?: boolean;
  approvalMode?: "ask" | "auto";
  eventSubscriptionError?: string;
  phase: "disconnected" | "setting_up" | "connecting" | "awaiting_phone" | "connected" | "error";
  botId?: string;
  ownerPhone?: string;
  identityHandle?: string;
  pairing?: { number: string; connectText: string; smsLink: string };
  error?: string;
  canReconnect: boolean;
  deliveries: Array<InkboxDeliveryPreview & { id: string; sender: string; channel?: string; status: string; text?: string; receivedAt?: number; reply?: string; error?: string }>;
}
export interface InkboxSetupInput { apiKey: string; botId: string; ownerPhone: string }
/** Implemented only by the trusted desktop parent, with no plaintext fallback. */
export interface InkboxSecretStore {
  readonly available: boolean;
  read(): Promise<unknown | null>;
  write(value: unknown | null): Promise<void>;
}
