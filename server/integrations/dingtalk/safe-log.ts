import { createHash } from "node:crypto";

export interface SafeDingTalkLogEvent {
  event: string;
  topic?: string;
  transportMessageIdHash?: string;
  sourceEventIdHash?: string;
  workItemId?: string | null;
  duplicate?: boolean;
  code?: string;
}

export interface DingTalkSafeLogger {
  write(event: SafeDingTalkLogEvent): void;
}

export function stableIdentifierHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function safeErrorCode(error: unknown): string {
  const allowed = new Set([
    "dingtalk_payload_invalid",
    "dingtalk_payload_too_large",
    "dingtalk_action_data_invalid",
    "dingtalk_transport_message_id_missing",
    "ledger_write_failed",
  ]);
  if (error instanceof Error && allowed.has(error.message)) return error.message;
  return "dingtalk_transport_error";
}

export class NullDingTalkSafeLogger implements DingTalkSafeLogger {
  write(_event: SafeDingTalkLogEvent): void {}
}
