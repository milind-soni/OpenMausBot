import { describe, expect, it } from "vitest";

import { FetchDingTalkInteractiveCardSender } from "./interactive-card-sender.ts";

describe("DingTalk interactive card sender", () => {
  it("exchanges app credentials and creates a STREAM callback card in the target group", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sender = new FetchDingTalkInteractiveCardSender(
      { load: () => ({ clientId: "app-key", clientSecret: "app-secret" }) },
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/v1.0/oauth2/accessToken")) {
          return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), { status: 200 });
        }
        return new Response(JSON.stringify({ processQueryKey: "query-key" }), { status: 200 });
      },
    );
    await expect(sender.send({
      proactiveOpenConversationId: "cid-group",
      idempotencyKey: "outbox-1",
      payload: {
        type: "plan_status_card",
        headline: "候选已就绪",
        cardTemplateId: "template-1",
        outTrackId: "candidate-run-1",
        workItemId: "WI-1",
        workItemVersion: 4,
        status: "candidate_ready",
        summary: "目标测试已通过",
        candidateSha: "2".repeat(40),
        actions: [
          { label: "接受候选", actionToken: "accept-token" },
          { label: "拒绝候选", actionToken: "reject-token" },
        ],
      },
    })).resolves.toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      init: { method: "POST" },
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ appKey: "app-key", appSecret: "app-secret" });
    expect(calls[1]).toMatchObject({
      url: "https://api.dingtalk.com/v1.0/card/instances/createAndDeliver",
      init: {
        method: "POST",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "access-token" }),
      },
    });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      cardTemplateId: "template-1",
      outTrackId: "candidate-run-1",
      callbackType: "STREAM",
      cardData: {
        cardParamMap: {
          title: "执行完成，请验收",
          status: "等待验收",
        },
      },
      privateData: {
        actionTokens: { "action-1": "accept-token", "action-2": "reject-token" },
      },
      imGroupOpenSpaceModel: { supportForward: false },
      imGroupOpenDeliverModel: { robotCode: "app-key", openConversationId: "cid-group" },
    });
    expect(String(calls[1].init?.body)).not.toContain("2".repeat(40));
  });

  it("actively sends ordinary Markdown without a card template", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sender = new FetchDingTalkInteractiveCardSender(
      { load: () => ({ clientId: "app-key", clientSecret: "app-secret" }) },
      async (url, init) => {
        calls.push({ url: String(url), init });
        if (String(url).endsWith("/v1.0/oauth2/accessToken")) {
          return new Response(JSON.stringify({ accessToken: "access-token", expireIn: 7200 }), { status: 200 });
        }
        return new Response(JSON.stringify({ processQueryKey: "message-query-key" }), { status: 200 });
      },
    );
    await expect(sender.send({
      proactiveOpenConversationId: "cid-group",
      idempotencyKey: "ordinary-1",
      payload: {
        type: "plan_status_card",
        headline: "候选已就绪",
        workItemId: "WI-1",
        status: "candidate_ready",
        summary: "请验收",
        actions: [
          { label: "接受候选", actionToken: "accept_code_12345678901234567890123456789012" },
          { label: "拒绝候选", actionToken: "reject_code_12345678901234567890123456789012" },
        ],
      },
    })).resolves.toEqual({ ok: true, status: 200 });
    expect(calls[1]?.url).toBe("https://api.dingtalk.com/v1.0/robot/groupMessages/send");
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      msgKey: "sampleMarkdown",
      openConversationId: "cid-group",
      robotCode: "app-key",
    });
    const message = JSON.parse(String(body.msgParam)) as { title: string; text: string };
    expect(message.title).toBe("执行完成，请验收");
    expect(message.text).toContain("@研发助手 接受 accept_code_");
  });
});
