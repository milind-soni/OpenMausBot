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

export function normalizeBotMessage(envelope: DingTalkStreamEnvelope): NormalizedDingTalkMessage {
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
  const transportMessageId = envelope.headers.messageId.trim();
  if (!transportMessageId) throw new Error("dingtalk_transport_message_id_missing");
  const conversationId = requiredOpaque(record, "conversationId", 256);
  const senderCorpId = optionalString(record, "senderCorpId", 256);
  const senderStaffId = optionalString(record, "senderStaffId", 256);
  const senderId =
    optionalString(record, "senderId", 256) ??
    `unresolved-${createHash("sha256").update(`${senderCorpId ?? ""}\0${senderStaffId ?? ""}\0${transportMessageId}`).digest("hex").slice(0, 20)}`;
  const receivedAt = numeric(record.createAt) ?? numeric(envelope.headers.time) ?? Date.now();
  const sessionWebhook = optionalString(record, "sessionWebhook", 4_096);
  const sessionWebhookExpiredTime = numeric(record.sessionWebhookExpiredTime);

  return {
    message: {
      sourceEventId,
      transportMessageId,
      conversationId,
      addressedToBot: true,
      text,
      ...(optionalString(record, "originalMsgId", 256)
        ? { replyToSourceEventId: optionalString(record, "originalMsgId", 256) }
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

export function normalizeCardAction(envelope: DingTalkStreamEnvelope): DingTalkCardAction {
  const record = parsePayload(envelope.data);
  const action = actionData(record);
  const actionToken = requiredOpaque(action, "actionToken", 1_024);
  const senderCorpId = optionalString(record, "senderCorpId", 256) ?? optionalString(record, "corpId", 256);
  const senderStaffId = optionalString(record, "senderStaffId", 256) ?? optionalString(record, "userId", 256);
  const transportMessageId = envelope.headers.messageId.trim();
  if (!transportMessageId) throw new Error("dingtalk_transport_message_id_missing");
  return {
    transportEventId: envelope.headers.eventId?.trim() || transportMessageId,
    transportMessageId,
    actionToken,
    sender: {
      ...(senderCorpId ? { senderCorpId } : {}),
      ...(senderStaffId ? { senderStaffId } : {}),
      senderId: optionalString(record, "senderId", 256) ?? senderStaffId ?? `unresolved-${transportMessageId}`,
      displayName: optionalString(record, "senderNick", 256) ?? "DingTalk member",
    },
    ...(optionalString(action, "reason", MAX_REASON_CHARACTERS)
      ? { reason: optionalString(action, "reason", MAX_REASON_CHARACTERS) }
      : {}),
    receivedAt: numeric(record.createAt) ?? numeric(envelope.headers.time) ?? Date.now(),
  };
}
