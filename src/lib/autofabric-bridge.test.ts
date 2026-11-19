import { describe, expect, it } from "vitest";
import {
  collectLocalBotAsks,
  formatHoldCountdown,
  inferFactoryDomain,
  readAutofabricEndpoint,
  writeAutofabricEndpoint,
} from "./autofabric-bridge";
import type { Bot, Message } from "@/state/store";

describe("inferFactoryDomain", () => {
  it("classifies infra repositories accurately", () => {
    expect(inferFactoryDomain("aer-runtime")).toBe("infra");
    expect(inferFactoryDomain("relayon-bus")).toBe("infra");
    expect(inferFactoryDomain("autofabric-engine")).toBe("infra");
    expect(inferFactoryDomain("invari-spec")).toBe("infra");
    expect(inferFactoryDomain("infra-tools")).toBe("infra");
    expect(inferFactoryDomain("AER-GATEWAY")).toBe("infra");
  });

  it("classifies fulfill repositories accurately", () => {
    expect(inferFactoryDomain("sheerid-verifier")).toBe("fulfill");
    expect(inferFactoryDomain("chromium-profile-matrix")).toBe("fulfill");
    expect(inferFactoryDomain("verisig-auth")).toBe("fulfill");
    expect(inferFactoryDomain("kirox-workflow")).toBe("fulfill");
    expect(inferFactoryDomain("getotp-proxy")).toBe("fulfill");
    expect(inferFactoryDomain("FULFILL-RISK")).toBe("fulfill");
  });

  it("classifies app repositories accurately", () => {
    expect(inferFactoryDomain("gptibo-web")).toBe("app");
    expect(inferFactoryDomain("citeprime-agent")).toBe("app");
    expect(inferFactoryDomain("fetchinbox-service")).toBe("app");
    expect(inferFactoryDomain("openmausbot-desktop")).toBe("app");
    expect(inferFactoryDomain("app-marketing")).toBe("app");
  });

  it("falls back to other for unknown repository names", () => {
    expect(inferFactoryDomain("misc-utilities")).toBe("other");
    expect(inferFactoryDomain("scratchpad")).toBe("other");
  });
});

describe("formatHoldCountdown", () => {
  it("returns null for non-finite or empty epoch inputs", () => {
    expect(formatHoldCountdown(undefined)).toBeNull();
    expect(formatHoldCountdown(null)).toBeNull();
    expect(formatHoldCountdown(Number.NaN)).toBeNull();
  });

  it("returns expired notice when time is past or zero", () => {
    expect(formatHoldCountdown(1000, 1000)).toBe("HOLD 已到期 (锁定中)");
    expect(formatHoldCountdown(900, 1000)).toBe("HOLD 已到期 (锁定中)");
  });

  it("formats remaining hours and minutes correctly", () => {
    const now = 1000;
    // 2h 15m remaining = 2 * 3600 + 15 * 60 = 7200 + 900 = 8100s
    expect(formatHoldCountdown(now + 8100, now)).toBe("HOLD 剩余 02h 15m");
    // 48h 00m remaining
    expect(formatHoldCountdown(now + 48 * 3600, now)).toBe("HOLD 剩余 48h 00m");
    // 5m remaining
    expect(formatHoldCountdown(now + 300, now)).toBe("HOLD 剩余 00h 05m");
  });
});

describe("collectLocalBotAsks", () => {
  const baseBot = (id: string, name: string, overrides: Partial<Bot> = {}): Bot =>
    ({
      id,
      name,
      threadId: `thread-${id}`,
      hidden: false,
      messages: [],
      activity: "idle",
      tasks: [{ id: `task-${id}`, threadId: `thread-${id}`, title: `${name}主任务` }],
      ...overrides,
    }) as unknown as Bot;

  it("ignores hidden bots", () => {
    const hiddenBot = baseBot("b-hidden", "隐藏Bot", {
      hidden: true,
      activity: "waiting-on-you",
    });
    const result = collectLocalBotAsks([hiddenBot]);
    expect(result).toHaveLength(0);
  });

  it("extracts pending approvals from bot messages", () => {
    const approvalMsg: Message = {
      id: "msg-approval-1",
      role: "bot",
      kind: "options",
      at: 1700000001000,
      card: {
        requestId: "req-app-1",
        tool: "Bash",
        title: "执行系统升级",
        subtitle: "需要终端命令执行权限",
        
        dismissed: false,
        expired: false,
        options: ["允许", "拒绝"],
      },
    };

    const bot = baseBot("b-dev", "全栈开发", {
      messages: [approvalMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "approval:b-dev:req-app-1",
      kind: "approval",
      threadTitle: "全栈开发主任务",
      headline: "执行系统升级",
      detail: "需要终端命令执行权限",
      requestId: "req-app-1",
      at: 1700000001000,
    });
  });

  it("extracts active secret requests and ignores fulfilled/closed ones", () => {
    const activeSecretMsg: Message = {
      id: "msg-sec-1",
      role: "bot",
      kind: "secret",
      at: 1700000002000,
      secret: {
        target: "customSecret",
        requestKey: "key-1",
        label: "GitHub Personal Access Token",
        reason: "用于自动化克隆并推送私有分支",
        description: "请输入 GitHub PAT",
        placeholder: "ghp_...",
        helpUrl: "",
      },
    };

    const providedSecretMsg: Message = {
      id: "msg-sec-2",
      role: "bot",
      kind: "secret",
      at: 1700000001500,
      secret: {
        target: "customSecret",
        requestKey: "key-2",
        label: "Old Token",
        description: "已提供凭证",
        placeholder: "",
        helpUrl: "",
        provided: true,
      },
    };

    const bot = baseBot("b-sec", "运维工程师", {
      messages: [activeSecretMsg, providedSecretMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "secret:b-sec:msg-sec-1",
      kind: "secret",
      headline: "需要输入凭证：GitHub Personal Access Token",
      detail: "用于自动化克隆并推送私有分支",
      at: 1700000002000,
    });
  });

  it("extracts active signin requests and ignores completed/cancelled ones", () => {
    const activeSigninMsg: Message = {
      id: "msg-sign-1",
      role: "bot",
      kind: "signin",
      at: 1700000003000,
      signIn: {
        url: "https://auth.example.com",
        site: "example.com",
        reason: "需要完成 SSO 登录以接入数据",
        place: "browser",
      },
    };

    const cancelledSigninMsg: Message = {
      id: "msg-sign-2",
      role: "bot",
      kind: "signin",
      at: 1700000002500,
      signIn: {
        url: "https://auth.cancelled.com",
        site: "cancelled.com",
        place: "browser",
        cancelled: true,
      },
    };

    const bot = baseBot("b-sign", "体验设计师", {
      messages: [activeSigninMsg, cancelledSigninMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "signin:b-sign:msg-sign-1",
      kind: "signin",
      headline: "需要登录验证：example.com",
      detail: "需要完成 SSO 登录以接入数据",
      at: 1700000003000,
    });
  });

  it("extracts waiting-on-you bot activity and extracts last bot message snippet", () => {
    const botMsg: Message = {
      id: "msg-bot-text",
      role: "bot",
      kind: "text",
      at: 1700000004000,
      text: "请问是否确认将分支重置并升级软件架构师会诊？",
    };

    const bot = baseBot("b-waiting", "测试质保员", {
      activity: "waiting-on-you",
      messages: [botMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "waiting:b-waiting:thread-b-waiting",
      kind: "waiting",
      headline: "测试质保员 正在等待你的回复",
      detail: "请问是否确认将分支重置并升级软件架构师会诊？",
      at: 1700000004000,
    });
  });

  it("deduplicates waiting-on-you when a card ask already exists for that thread", () => {
    const signinMsg: Message = {
      id: "msg-sign-dupe",
      role: "bot",
      kind: "signin",
      at: 1700000005000,
      signIn: {
        url: "https://auth.example.com",
        site: "example.com",
        place: "browser",
      },
    };

    const bot = baseBot("b-dupe", "社媒运营官", {
      activity: "waiting-on-you",
      messages: [signinMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("signin");
  });

  it("sorts items by timestamp descending", () => {
    const older: Message = {
      id: "msg-old",
      role: "bot",
      kind: "options",
      at: 1000,
      card: {
        requestId: "req-old",
        tool: "Bash", title: "Old Task", subtitle: "sub", options: ["A"],
      },
    };
    const newer: Message = {
      id: "msg-new",
      role: "bot",
      kind: "options",
      at: 2000,
      card: {
        requestId: "req-new",
        tool: "Bash", title: "New Task", subtitle: "sub", options: ["B"],
      },
    };

    const bot1 = baseBot("b1", "Bot1", { messages: [older] });
    const bot2 = baseBot("b2", "Bot2", { messages: [newer] });

    const result = collectLocalBotAsks([bot1, bot2]);
    expect(result.map((r) => r.at)).toEqual([2000, 1000]);
  });
});

describe("endpoint helpers", () => {
  it("reads and normalizes autofabric endpoint", () => {
    expect(readAutofabricEndpoint()).toContain("http");
    const cleaned = writeAutofabricEndpoint("http://localhost:8787///");
    expect(cleaned).toBe("http://localhost:8787");
  });
});