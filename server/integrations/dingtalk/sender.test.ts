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
  it("presents a ready plan in language product and project users can understand", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "计划已发布",
      workItemId: "WI-35CFBA362138",
      status: "ready_for_execution",
      summary: "把 pilot-output.txt 的内容修改为 hello pilot，并运行 pilot 验证。",
    });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("方案已确认，准备执行");
    expect(markdown.text).toContain("任务内容");
    expect(markdown.text).toContain("当前进度：准备开始");
    expect(markdown.text).toContain("下一步：系统将自动执行，完成后通知你验收");
    expect(markdown.text).toContain("任务编号");
    expect(markdown.text).not.toContain("ready_for_execution");
    expect(markdown.text).not.toContain("Work Item");
  });

  it("shows the concrete candidate diff instead of only its SHA and path", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "候选已就绪",
      workItemId: "WI-D183F9E734FE",
      status: "candidate_ready",
      summary: "修改已完成并通过验证，请确认结果是否符合需求。",
      candidateSha: "2570cfb4692ad7775e261f403964d5585a95de7e",
      changedPaths: ["pilot-output.txt"],
      testStates: ["pilot: target_passed"],
      candidatePreview: "@@ -1 +1 @@\n-pending\n+hello pilot",
      actions: [
        { label: "接受候选", actionToken: "accept_code_12345678901234567890123456789012" },
        { label: "拒绝候选", actionToken: "reject_code_12345678901234567890123456789012" },
      ],
    });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("执行完成，请验收");
    expect(markdown.text).toContain("修改前");
    expect(markdown.text).toContain("pending");
    expect(markdown.text).toContain("修改后");
    expect(markdown.text).toContain("hello pilot");
    expect(markdown.text).toContain("验证结果：pilot 已通过");
    expect(markdown.text).toContain("请由任务负责人在 30 分钟内回复以下一条");
    expect(markdown.text).toContain("@研发助手 接受 accept_code_");
    expect(markdown.text).toContain("@研发助手 拒绝 reject_code_");
    expect(markdown.text).toContain("@研发助手 刷新验收码 WI-D183F9E734FE");
    expect(markdown.text).not.toContain("candidate_ready");
    expect(markdown.text).not.toContain("target_passed");
    expect(markdown.text).not.toContain("2570cfb4692ad7775e261f403964d5585a95de7e");
  });

  it("renders command outcomes and hides internal failure codes from group users", async () => {
    const requests: unknown[] = [];
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as unknown);
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "command_status_card",
      headline: "控制操作已执行",
      command: "pause",
      workItemId: "WI-D183F9E734FE",
      outcome: "allowed",
      summary: "任务已暂停；正在运行的执行会收到中断请求。",
      workItemStatus: "collecting",
      definitionStatus: "ready_for_execution",
      controlState: "paused",
    });
    await sender.send("https://api.dingtalk.com/session-webhook", {
      type: "plan_status_card",
      headline: "执行未完成",
      workItemId: "WI-D183F9E734FE",
      status: "execution_failed",
      failures: ["provider_sandbox_unavailable"],
    });
    const commandText = (requests[0] as { markdown: { text: string } }).markdown.text;
    expect(commandText).toContain("任务已暂停");
    expect(commandText).toContain("控制状态：已暂停");
    expect(commandText).not.toContain("ready_for_execution");
    const failureText = (requests[1] as { markdown: { text: string } }).markdown.text;
    expect(failureText).toContain("执行环境暂不可用");
    expect(failureText).not.toContain("provider_sandbox_unavailable");
  });

  it("renders a documented Markdown webhook payload and requires business success", async () => {
    let requestBody: unknown;
    const sender = new FetchDingTalkSessionSender(async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({ errcode: 0, errmsg: "ok" }), { status: 200 });
    });
    await expect(sender.send("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", primaryStatus))
      .resolves.toEqual({ ok: true, status: 200 });
    const markdown = (requestBody as { markdown: { title: string; text: string } }).markdown;
    expect(markdown.title).toBe("需求已收到");
    expect(markdown.text).toContain("已收到你的需求，正在整理。当前尚未开始执行");
    expect(markdown.text).toContain("当前进度：正在整理需求");
    expect(markdown.text).toContain("任务编号");
    expect(markdown.text).not.toContain("collecting");
    expect(markdown.text).not.toContain("Work Item");
    expect(markdown.text).not.toContain("协作账本");
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
