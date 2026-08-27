import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import type { OwnerActionOutcome } from "../../collaboration/actions.ts";
import type { DingTalkCardAction, DingTalkInboundMessage, DingTalkStreamEnvelope } from "./types.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface DingTalkInboundSink {
  ingest(message: DingTalkInboundMessage): MaybePromise<InboundMessageOutcome>;
}

export interface DingTalkOwnerActionSink {
  perform(action: DingTalkCardAction): MaybePromise<OwnerActionOutcome>;
}

export interface DingTalkStreamSdkPort {
  subscribe(topic: "robot" | "card", handler: (message: DingTalkStreamEnvelope) => MaybePromise<void>): void;
  connect(): Promise<{ connected: boolean }>;
  disconnect(): void;
  acknowledge(transportMessageId: string): void;
}

export interface DingTalkHttpResult {
  ok: boolean;
  status: number;
  code?: string;
}

export interface DingTalkSessionSendPort {
  send(webhookUrl: string, payload: unknown): Promise<DingTalkHttpResult>;
}

export interface DingTalkActiveSendPort {
  send(input: {
    proactiveOpenConversationId: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkHttpResult>;
}

export type DingTalkDeliveryResult =
  | { kind: "sent"; channel: "session" | "proactive" }
  | { kind: "retryable"; code: string }
  | { kind: "permanent"; code: string };

/** Transport-neutral shape consumed by the collaboration outbox dispatcher. */
export interface DingTalkDeliveryPort {
  send(input: {
    sourceEventId?: string;
    proactiveOpenConversationId?: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkDeliveryResult>;
}
