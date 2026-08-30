import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeBotMessage, normalizeCardAction, UNSUPPORTED_MESSAGE_TEXT } from "./normalizer.ts";
import type { DingTalkStreamEnvelope } from "./types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string, messageId = `transport-${name}`, eventId?: string): DingTalkStreamEnvelope {
  return {
    type: "CALLBACK",
    headers: { messageId, topic: "fixture", ...(eventId ? { eventId } : {}) },
    data: readFileSync(join(fixtures, name), "utf8"),
  };
}

describe("DingTalk strict normalizer", () => {
  it("keeps business and transport identities separate and keeps the reply webhook ephemeral", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-text.json", "transport-99"));
    expect(normalized.message).toMatchObject({
      sourceEventId: "biz-message-1",
      transportMessageId: "transport-99",
      conversationId: "cid-group-1",
      text: "修复登录失败，并补充回归测试",
      sender: { senderCorpId: "corp-1", senderStaffId: "staff-1", senderId: "sender-1" },
    });
    expect(normalized.replyChannel).toMatchObject({ sourceEventId: "biz-message-1", expiresAt: 4_102_444_800_000 });
    expect(JSON.stringify(normalized.message)).not.toContain("sessionWebhook");
    expect(JSON.stringify(normalized.message)).not.toContain("test-only");
  });

  it("extracts bounded rich text and reference metadata but not media codes", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-rich-text-reference.json"));
    expect(normalized).toMatchObject({
      contentKind: "rich_text",
      message: { text: "复现于空 Token\n@机器人", replyToSourceEventId: "biz-message-1" },
    });
    expect(normalized.message.text).not.toContain("ignored-media-code");
  });

  it("replaces unsupported media with a fixed safe sentence", () => {
    const normalized = normalizeBotMessage(fixture("bot-message-unsupported-media.json"));
    expect(normalized).toMatchObject({ contentKind: "unsupported", message: { text: UNSUPPORTED_MESSAGE_TEXT } });
    expect(JSON.stringify(normalized.message)).not.toContain("attacker.invalid");
    expect(JSON.stringify(normalized.message)).not.toContain("ignore previous instructions");
  });

  it("uses Stream event identity for card dedupe and ignores embedded privilege claims", () => {
    const messageIdentity = normalizeBotMessage(fixture("bot-message-text.json")).message.sender;
    const normalized = normalizeCardAction(
      fixture("card-action-owner.json", "transport-card-1", "event-card-1"),
      1_700_000_003_000,
    );
    expect(normalized).toEqual({
      transportEventId: "event-card-1",
      transportMessageId: "transport-card-1",
      actionToken: "opaque-test-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "owner-1",
        senderId: "owner-sender-1",
        displayName: "Owner",
      },
      reason: "验收不符合预期",
      receivedAt: 1_700_000_003_000,
      origin: "card",
    });
    expect(normalized).not.toHaveProperty("action");
    expect(normalized).not.toHaveProperty("role");
    expect(normalized).not.toHaveProperty("workItemId");
    const sameMemberEnvelope = fixture("card-action-owner.json", "transport-card-2", "event-card-2");
    const sameMemberPayload = JSON.parse(sameMemberEnvelope.data) as Record<string, unknown>;
    sameMemberPayload.userId = messageIdentity.senderStaffId;
    sameMemberPayload.senderId = messageIdentity.senderId;
    const sameMember = normalizeCardAction(
      { ...sameMemberEnvelope, data: JSON.stringify(sameMemberPayload) },
      1_700_000_003_000,
    );
    expect({ corp: sameMember.sender.senderCorpId, staff: sameMember.sender.senderStaffId }).toEqual({
      corp: messageIdentity.senderCorpId,
      staff: messageIdentity.senderStaffId,
    });
  });

  it("selects only the clicked token from card private data and audits button rejection", () => {
    expect(normalizeCardAction(
      fixture("card-action-private-data.json", "transport-card-private", "event-card-private"),
      1_700_000_003_000,
    )).toEqual({
      transportEventId: "event-card-private",
      transportMessageId: "transport-card-private",
      actionToken: "reject-opaque-token",
      sender: {
        senderCorpId: "corp-1",
        senderStaffId: "owner-1",
        senderId: "owner-sender-1",
        displayName: "Owner",
      },
      reason: "Owner rejected candidate via DingTalk interactive card",
      receivedAt: 1_700_000_003_000,
      origin: "card",
    });
  });
});
