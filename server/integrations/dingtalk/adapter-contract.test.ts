import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { InboundMessageOutcome } from "../../collaboration/inbound.ts";
import { FakeDingTalkAdapter } from "./fake-adapter.ts";
import { normalizeBotMessage } from "./normalizer.ts";
import type { DingTalkInboundMessage, DingTalkStreamEnvelope } from "./types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function accepted(message: DingTalkInboundMessage): InboundMessageOutcome {
  return {
    accepted: true,
    duplicate: false,
    sourceEventId: message.sourceEventId,
    transportMessageId: message.transportMessageId,
    principalId: "principal-1",
    principalResolution: "resolved",
    association: "created",
    workItemId: "WI-1",
    card: {
      type: "primary_status_card",
      headline: "已接收",
      acknowledgement: "durable",
      workItemId: "WI-1",
      workItemStatus: "collecting",
      workItemVersion: 1,
      association: "created",
    },
    outboxId: "outbox-1",
  };
}

describe("fake and Stream adapter contract", () => {
  it("delivers the same normalized message shape to collaboration ingress", () => {
    const envelope: DingTalkStreamEnvelope = {
      type: "CALLBACK",
      headers: { messageId: "transport-1", topic: "robot" },
      data: readFileSync(join(fixtures, "bot-message-text.json"), "utf8"),
    };
    const streamMessage = normalizeBotMessage(envelope).message;
    let fakeMessage: DingTalkInboundMessage | undefined;
    const fake = new FakeDingTalkAdapter((message) => {
      fakeMessage = message;
      return accepted(message);
    });
    expect(fake.receive(streamMessage)).toMatchObject({ accepted: true, sourceEventId: "biz-message-1" });
    expect(fakeMessage).toEqual(streamMessage);
  });
});
