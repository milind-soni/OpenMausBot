import type {
  DingTalkActiveSendPort,
  DingTalkDeliveryPort,
  DingTalkDeliveryResult,
  DingTalkSessionSendPort,
} from "./ports.ts";
import type { DingTalkSessionReplyChannel } from "./types.ts";

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function validSessionWebhook(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "dingtalk.com" && !url.hostname.endsWith(".dingtalk.com"))) {
    throw new Error("dingtalk_session_webhook_invalid");
  }
  return url;
}

export class DingTalkSessionReplyRegistry {
  private readonly channels = new Map<string, DingTalkSessionReplyChannel>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  capture(channel: DingTalkSessionReplyChannel): void {
    validSessionWebhook(channel.webhookUrl);
    if (!Number.isSafeInteger(channel.expiresAt) || channel.expiresAt <= this.now()) return;
    this.channels.set(channel.sourceEventId, { ...channel });
  }

  active(sourceEventId: string): DingTalkSessionReplyChannel | null {
    const channel = this.channels.get(sourceEventId);
    if (!channel) return null;
    if (channel.expiresAt <= this.now()) {
      this.channels.delete(sourceEventId);
      return null;
    }
    return { ...channel };
  }

  consume(sourceEventId: string): void {
    this.channels.delete(sourceEventId);
  }

  clear(): void {
    this.channels.clear();
  }
}

export class DingTalkReplyRouter implements DingTalkDeliveryPort {
  private readonly sessions: DingTalkSessionReplyRegistry;
  private readonly sessionSender: DingTalkSessionSendPort;
  private readonly activeSender?: DingTalkActiveSendPort;

  constructor(
    sessions: DingTalkSessionReplyRegistry,
    sessionSender: DingTalkSessionSendPort,
    activeSender?: DingTalkActiveSendPort,
  ) {
    this.sessions = sessions;
    this.sessionSender = sessionSender;
    this.activeSender = activeSender;
  }

  async send(input: {
    sourceEventId?: string;
    proactiveOpenConversationId?: string;
    payload: unknown;
    idempotencyKey: string;
  }): Promise<DingTalkDeliveryResult> {
    const channel = input.sourceEventId ? this.sessions.active(input.sourceEventId) : null;
    if (channel) {
      try {
        const response = await this.sessionSender.send(channel.webhookUrl, input.payload);
        if (response.ok) {
          this.sessions.consume(channel.sourceEventId);
          return { kind: "sent", channel: "session" };
        }
        if (!input.proactiveOpenConversationId || !this.activeSender) {
          return isRetryableStatus(response.status)
            ? { kind: "retryable", code: response.code ?? "session_send_failed" }
            : { kind: "permanent", code: response.code ?? "session_send_rejected" };
        }
      } catch {
        if (!input.proactiveOpenConversationId || !this.activeSender) {
          return { kind: "retryable", code: "session_transport_error" };
        }
      }
    }

    if (!input.proactiveOpenConversationId || !this.activeSender) {
      return { kind: "permanent", code: "delivery_unroutable" };
    }
    try {
      const response = await this.activeSender.send({
        proactiveOpenConversationId: input.proactiveOpenConversationId,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
      if (response.ok) return { kind: "sent", channel: "proactive" };
      return isRetryableStatus(response.status)
        ? { kind: "retryable", code: response.code ?? "proactive_send_failed" }
        : { kind: "permanent", code: response.code ?? "proactive_send_rejected" };
    } catch {
      return { kind: "retryable", code: "proactive_transport_error" };
    }
  }
}
