import { createHash } from "node:crypto";

import type {
  DingTalkCardAction,
  DingTalkStreamEnvelope,
  NormalizedDingTalkMessage,
} from "./types.ts";

const MAX_PAYLOAD_BYTES = 256_000;
const MAX_TEXT_CHARACTERS = 8_000;
const MAX_REASON_CHARACTERS = 2_000;
export const UNSUPPORTED_MESSAGE_TEXT = "收到不支持的消息类型，内容未读取。";

type JsonObject = Record<string, unknown>;

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}_invalid`);
  return value as JsonObject;
}

function parsePayload(data: string): JsonObject {
  if (Buffer.byteLength(data, "utf8") > MAX_PAYLOAD_BYTES) throw new Error("dingtalk_payload_too_large");
  try {
    return object(JSON.parse(data), "dingtalk_payload");
  } catch (error) {
    if (error instanceof Error && error.message === "dingtalk_payload_invalid") throw error;
    throw new Error("dingtalk_payload_invalid");
  }
}

function optionalString(record: JsonObject, key: string, maximum = 512): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function requiredString(record: JsonObject, key: string, maximum = 512): string {
  const raw = record[key];
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_missing`);
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").trim();
  if (!value) throw new Error(`dingtalk_${key}_missing`);
  if (value.length > maximum) throw new Error(`dingtalk_${key}_too_large`);
  return value;
}

function requiredOpaque(record: JsonObject, key: string, maximum = 512): string {
  const value = requiredString(record, key, maximum);
  if (/\s/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function optionalOpaque(record: JsonObject, key: string, maximum = 512): string | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_invalid`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > maximum || /\s|[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function envelopeIdentifier(value: string | undefined, key: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) throw new Error(`dingtalk_${key}_missing`);
  if (normalized.length > 256 || /\s|[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`dingtalk_${key}_invalid`);
  }
  return normalized;
}

function optionalExactText(record: JsonObject, key: string, maximum: number): string | undefined {
  const raw = record[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`dingtalk_${key}_invalid`);
  const value = raw.trim();
  if (!value) return undefined;
  if (value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`dingtalk_${key}_invalid`);
  return value;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{1,16}$/u.test(value)) return Number(value);
  return undefined;
}

function payloadHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function richText(record: JsonObject): string | undefined {
  const content = record.content;
  const rich = content && typeof content === "object" && !Array.isArray(content)
    ? (content as JsonObject).richText
    : record.richText;
  if (!Array.isArray(rich)) return undefined;
  const fragments: string[] = [];
  for (const item of rich.slice(0, 200)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const safe = item as JsonObject;
    const text = optionalString(safe, "text", 2_000);
    const mention = optionalString(safe, "atName", 128);
    if (text) fragments.push(text);
    else if (mention) fragments.push(`@${mention}`);
    if (fragments.join("\n").length >= MAX_TEXT_CHARACTERS) break;
  }
  const combined = fragments.join("\n").trim().slice(0, MAX_TEXT_CHARACTERS);
  return combined || undefined;
}

function actionData(record: JsonObject): JsonObject {
  const raw = record.actionData ?? record.value ?? record.cardPrivateData;
  if (typeof raw === "string") {
    try {
      return object(JSON.parse(raw), "dingtalk_action_data");
    } catch {
      throw new Error("dingtalk_action_data_invalid");
    }
  }
  return object(raw, "dingtalk_action_data");
}

export function normalizeBotMessage(envelope: DingTalkStreamEnvelope, receivedAt = Date.now()): NormalizedDingTalkMessage {
  const record = parsePayload(envelope.data);
  const msgType = optionalString(record, "msgtype", 64)?.toLowerCase();
  let text: string;
  let contentKind: NormalizedDingTalkMessage["contentKind"];
  if (msgType === "text") {
    const textRecord = object(record.text, "dingtalk_text");
    text = requiredString(textRecord, "content", MAX_TEXT_CHARACTERS);
    contentKind = "text";
  } else if (msgType === "richtext" || msgType === "rich_text") {
    text = richText(record) ?? UNSUPPORTED_MESSAGE_TEXT;
    contentKind = text === UNSUPPORTED_MESSAGE_TEXT ? "unsupported" : "rich_text";
  } else {
    text = UNSUPPORTED_MESSAGE_TEXT;
    contentKind = "unsupported";
  }

  const sourceEventId = requiredOpaque(record, "msgId", 256);
  const transportMessageId = envelopeIdentifier(envelope.headers.messageId, "transport_message_id");
  const conversationId = requiredOpaque(record, "conversationId", 256);
  const senderCorpId = optionalOpaque(record, "senderCorpId", 256);
  const senderStaffId = optionalOpaque(record, "senderStaffId", 256);
  const senderId =
    optionalOpaque(record, "senderId", 256) ??
    `unresolved-${createHash("sha256").update(`${senderCorpId ?? ""}\0${senderStaffId ?? ""}\0${transportMessageId}`).digest("hex").slice(0, 20)}`;
  const sessionWebhook = optionalExactText(record, "sessionWebhook", 4_096);
  const sessionWebhookExpiredTime = numeric(record.sessionWebhookExpiredTime);

  return {
    message: {
      sourceEventId,
      transportMessageId,
      conversationId,
      addressedToBot: true,
      text,
      ...(optionalOpaque(record, "originalMsgId", 256)
        ? { replyToSourceEventId: optionalOpaque(record, "originalMsgId", 256) }
        : {}),
      sender: {
        ...(senderCorpId ? { senderCorpId } : {}),
        ...(senderStaffId ? { senderStaffId } : {}),
        senderId,
        displayName: optionalString(record, "senderNick", 256) ?? "DingTalk member",
      },
      receivedAt,
    },
    ...(sessionWebhook && sessionWebhookExpiredTime
      ? { replyChannel: { sourceEventId, webhookUrl: sessionWebhook, expiresAt: sessionWebhookExpiredTime } }
      : {}),
    contentKind,
    payloadHash: payloadHash(envelope.data),
  };
}

export function normalizeCardAction(envelope: DingTalkStreamEnvelope, receivedAt = Date.now()): DingTalkCardAction {
  const record = parsePayload(envelope.data);
  const action = actionData(record);
  const actionId = optionalOpaque(action, "actionId", 128) ?? optionalOpaque(record, "actionId", 128);
  let actionToken = optionalOpaque(action, "actionToken", 1_024);
  if (!actionToken && actionId) {
    const privateData = actionData({ actionData: record.cardPrivateData });
    const tokens = object(privateData.actionTokens, "dingtalk_action_tokens");
    actionToken = requiredOpaque(tokens, actionId, 1_024);
  }
  if (!actionToken) throw new Error("dingtalk_actionToken_missing");
  const senderCorpId = optionalOpaque(record, "senderCorpId", 256) ?? optionalOpaque(record, "corpId", 256);
  const senderStaffId = optionalOpaque(record, "senderStaffId", 256) ?? optionalOpaque(record, "userId", 256);
  const transportMessageId = envelopeIdentifier(envelope.headers.messageId, "transport_message_id");
  return {
    transportEventId: envelope.headers.eventId
      ? envelopeIdentifier(envelope.headers.eventId, "transport_event_id")
      : transportMessageId,
    transportMessageId,
    actionToken,
    sender: {
      ...(senderCorpId ? { senderCorpId } : {}),
      ...(senderStaffId ? { senderStaffId } : {}),
      senderId: optionalOpaque(record, "senderId", 256) ?? senderStaffId ?? `unresolved-${transportMessageId}`,
      displayName: optionalString(record, "senderNick", 256) ?? "DingTalk member",
    },
    ...(optionalString(action, "reason", MAX_REASON_CHARACTERS)
      ? { reason: optionalString(action, "reason", MAX_REASON_CHARACTERS) }
      : actionId === "action-2"
        ? { reason: "Owner rejected candidate via DingTalk interactive card" }
        : {}),
    origin: "card",
    // Authorization TTLs use the service receive clock, never payload/header time.
    receivedAt,
  };
}
