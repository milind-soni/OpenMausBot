import { describe, expect, it } from "vitest";

import type { DingTalkActiveSendPort, DingTalkSessionSendPort } from "./ports.ts";
import { DingTalkReplyRouter, DingTalkSessionReplyRegistry } from "./reply-router.ts";

describe("DingTalk reply routing", () => {
  it("uses a live session webhook without confusing it with proactive conversation identity", async () => {
    const sessions = new DingTalkSessionReplyRegistry(() => 1_000);
    sessions.capture({
      sourceEventId: "event-1",
      webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      expiresAt: 2_000,
    });
    const sessionCalls: string[] = [];
    const sessionSender: DingTalkSessionSendPort = {
      async send(url) {
        sessionCalls.push(url);
        return { ok: true, status: 200 };
      },
    };
    const activeCalls: string[] = [];
    const activeSender: DingTalkActiveSendPort = {
      async send(input) {
        activeCalls.push(input.proactiveOpenConversationId);
        return { ok: true, status: 200 };
      },
    };
    const result = await new DingTalkReplyRouter(sessions, sessionSender, activeSender).send({
      sourceEventId: "event-1",
      proactiveOpenConversationId: "open-conversation-1",
      payload: { text: "ok" },
      idempotencyKey: "outbox-1",
    });
    expect(result).toEqual({ kind: "sent", channel: "session" });
    expect(sessionCalls).toHaveLength(1);
    expect(activeCalls).toEqual([]);
  });

  it("falls back to the explicitly configured proactive target after session expiry", async () => {
    let now = 1_000;
    const sessions = new DingTalkSessionReplyRegistry(() => now);
    sessions.capture({
      sourceEventId: "event-1",
      webhookUrl: "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
      expiresAt: 2_000,
    });
    now = 2_001;
    const targets: string[] = [];
    const router = new DingTalkReplyRouter(
      sessions,
      { send: async () => ({ ok: true, status: 200 }) },
      {
        async send(input) {
          targets.push(input.proactiveOpenConversationId);
          return { ok: true, status: 200 };
        },
      },
    );
    expect(await router.send({
      sourceEventId: "event-1",
      proactiveOpenConversationId: "open-conversation-1",
      payload: {},
      idempotencyKey: "outbox-1",
    })).toEqual({ kind: "sent", channel: "proactive" });
    expect(targets).toEqual(["open-conversation-1"]);
  });

  it("reports an unroutable delivery without rolling back business state", async () => {
    const router = new DingTalkReplyRouter(new DingTalkSessionReplyRegistry(), {
      send: async () => ({ ok: false, status: 410 }),
    });
    expect(await router.send({ payload: {}, idempotencyKey: "outbox-1" })).toEqual({
      kind: "permanent",
      code: "delivery_unroutable",
    });
  });
});
