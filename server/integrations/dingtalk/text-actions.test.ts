import { describe, expect, it } from "vitest";

import type { DingTalkInboundMessage } from "./types.ts";
import { parseDingTalkOwnerTextAction, parseDingTalkOwnerTextCommand } from "./text-actions.ts";

const token = "accept_code_12345678901234567890123456789012";

function message(text: string): DingTalkInboundMessage {
  return {
    sourceEventId: "source-1",
    transportMessageId: "transport-1",
    conversationId: "conversation-1",
    addressedToBot: true,
    text,
    sender: {
      senderCorpId: "corp-1",
      senderStaffId: "owner-1",
      senderId: "sender-1",
      displayName: "Owner",
    },
    receivedAt: 1_700_000_000_000,
  };
}

describe("DingTalk Owner text actions", () => {
  it("turns a copied acceptance command into the existing opaque-token action contract", () => {
    expect(parseDingTalkOwnerTextAction(message(`@研发助手 接受 ${token}`))).toEqual({
      transportEventId: "source-1",
      transportMessageId: "transport-1",
      actionToken: token,
      sender: message("").sender,
      receivedAt: 1_700_000_000_000,
      origin: "text",
    });
  });

  it("keeps rejection feedback and ignores ordinary product discussion", () => {
    expect(parseDingTalkOwnerTextAction(message(`@研发助手 拒绝 ${token} 登录页仍然报错`))).toMatchObject({
      actionToken: token,
      reason: "登录页仍然报错",
      origin: "text",
    });
    expect(parseDingTalkOwnerTextAction(message("这个候选我还需要看一下"))).toBeNull();
  });

  it("parses the deterministic WI-addressed command set without treating discussion as control", () => {
    const cases = [
      ["状态", "status"],
      ["暂停", "pause"],
      ["恢复", "resume"],
      ["重试", "retry"],
      ["取消", "cancel"],
      ["刷新验收码", "refresh_approval"],
    ] as const;
    for (const [label, command] of cases) {
      expect(parseDingTalkOwnerTextCommand(message(`@研发助手 ${label} WI-a1b2c3d4e5f6`))).toMatchObject({
        command,
        workItemId: "WI-A1B2C3D4E5F6",
        transportEventId: "source-1",
      });
    }
    expect(parseDingTalkOwnerTextCommand(message("我们是否应该暂停这个需求？"))).toBeNull();
    expect(parseDingTalkOwnerTextCommand(message("状态 WI-INVALID-001"))).toBeNull();
  });
});
