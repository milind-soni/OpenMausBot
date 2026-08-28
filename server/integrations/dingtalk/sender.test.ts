import { describe, expect, it } from "vitest";

import { FetchDingTalkSessionSender } from "./sender.ts";

const primaryStatus = {
  type: "primary_status_card",
  headline: "已接收",
  acknowledgement: "消息已接收并写入协作账本。",
  workItemId: "WI-TEST",
  workItemStatus: "collecting",
};

describe("DingTalk session sender", () => {
  it("renders a documented Markdown webhook payload and requires business success", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: true, status: 200 });
    expect(requestBody).toMatchObject({
      msgtype: "markdown",
      markdown: { title: "已接收", text: expect.stringContaining("WI\\-TEST") },
    });
  });

  it("does not treat an HTTP 200 DingTalk business error as sent", async () => {
    const sender = new FetchDingTalkSessionSender(async () =>
      new Response(JSON.stringify({ errcode: 310000, errmsg: "invalid payload" }), { status: 200 }));
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: false, status: 200, code: "dingtalk_310000" });
  });

  it("fails closed when a successful HTTP response has no verifiable business result", async () => {
    const sender = new FetchDingTalkSessionSender(async () => new Response("not-json", { status: 200 }));
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: false, status: 200, code: "dingtalk_response_invalid" });
  });
});
