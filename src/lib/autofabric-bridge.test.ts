import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AUTOFABRIC_ENDPOINT,
  FALLBACK_AUTOFABRIC_OVERVIEW,
  collectLocalBotAsks,
  formatCasError,
  formatHoldCountdown,
  inferFactoryDomain,
  readAutofabricEndpoint,
  sanitizeEndpoint,
  writeAutofabricEndpoint,
} from "./autofabric-bridge";
import type { Bot, Message, OptionCardData } from "@/state/store";

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

describe("formatCasError", () => {
  it("formats 409 CAS conflict accurately for cross-client desync", () => {
    expect(formatCasError(409)).toBe("并发状态冲突 (409)：该决策卡已被其他端处理，请刷新对账");
    expect(formatCasError(409, "version mismatch")).toBe("并发状态冲突 (409)：该决策卡已被其他端处理，请刷新对账");
  });

  it("formats non-409 HTTP errors with server response text", () => {
    expect(formatCasError(500, "Database locked")).toBe("CAS 批复失败 (HTTP 500): Database locked");
    expect(formatCasError(502)).toBe("CAS 批复失败 (HTTP 502)");
    expect(formatCasError(400, "Bad Request")).toBe("CAS 批复失败 (HTTP 400): Bad Request");
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

  it("extracts interactive options cards and filters out answered/dismissed/expired cards", () => {
    const activeOptionsMsg: Message = {
      id: "msg-opt-active",
      role: "bot",
      kind: "options",
      at: 1700000003500,
      card: {
        title: "部署方案选型",
        subtitle: "请选择目标环境流水线",
        options: ["全量金丝雀", "灰度 10%", "阻断回退"],
        dismissed: false,
        expired: false,
      },
    };

    const answeredOptionsMsg: Message = {
      id: "msg-opt-answered",
      role: "bot",
      kind: "options",
      at: 1700000003200,
      card: {
        title: "已决断方案",
        subtitle: "已完成选择",
        options: ["A", "B"],
        answered: "A",
      },
    };

    const dismissedOptionsMsg: Message = {
      id: "msg-opt-dismissed",
      role: "bot",
      kind: "options",
      at: 1700000003100,
      card: {
        title: "已废弃选项",
        subtitle: "无需操作",
        options: ["X", "Y"],
        dismissed: true,
      },
    };

    const expiredOptionsMsg: Message = {
      id: "msg-opt-expired",
      role: "bot",
      kind: "options",
      at: 1700000003000,
      card: {
        title: "已过期选项",
        subtitle: "已超期",
        options: ["1", "2"],
        expired: true,
      },
    };

    const bot = baseBot("b-opt", "软件架构师", {
      messages: [activeOptionsMsg, answeredOptionsMsg, dismissedOptionsMsg, expiredOptionsMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "options:b-opt:msg-opt-active",
      kind: "options",
      headline: "部署方案选型",
      detail: "请选择目标环境流水线",
      at: 1700000003500,
    });
  });

  it("provides sensible headline and detail fallbacks for options cards missing titles or subtitles", () => {
    const fallbackMsg: Message = {
      id: "msg-opt-fallback",
      role: "bot",
      kind: "options",
      at: 1700000003800,
      card: {
        options: ["继续重试", "取消中断"],
      } as unknown as OptionCardData,
    };

    const bot = baseBot("b-fallback", "提示词架构师", {
      messages: [fallbackMsg],
    });

    const result = collectLocalBotAsks([bot]);
    expect(result).toHaveLength(1);
    expect(result[0].headline).toBe("提示词架构师 等待你的选择");
    expect(result[0].detail).toBe("继续重试 / 取消中断");
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

  it("sorts items by timestamp descending across multiple bots and ask kinds", () => {
    const older: Message = {
      id: "msg-old",
      role: "bot",
      kind: "options",
      at: 1000,
      card: {
        requestId: "req-old",
        tool: "Bash",
        title: "Old Task",
        subtitle: "sub",
        options: ["A"],
      },
    };
    const middle: Message = {
      id: "msg-mid",
      role: "bot",
      kind: "options",
      at: 2000,
      card: {
        title: "Mid Task",
        subtitle: "Mid Sub",
        options: ["B"],
      },
    };
    const newer: Message = {
      id: "msg-new",
      role: "bot",
      kind: "signin",
      at: 3000,
      signIn: {
        site: "example.org",
        url: "https://example.org",
        place: "browser",
      },
    };

    const bot1 = baseBot("b1", "Bot1", { messages: [older] });
    const bot2 = baseBot("b2", "Bot2", { messages: [middle] });
    const bot3 = baseBot("b3", "Bot3", { messages: [newer] });

    const result = collectLocalBotAsks([bot1, bot2, bot3]);
    expect(result.map((r) => r.at)).toEqual([3000, 2000, 1000]);
    expect(result.map((r) => r.kind)).toEqual(["signin", "options", "approval"]);
  });
});

describe("endpoint helpers and protocol whitelist", () => {
  const memoryStore = new Map<string, string>();

  beforeEach(() => {
    memoryStore.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => memoryStore.get(key) ?? null,
      setItem: (key: string, val: string) => {
        memoryStore.set(key, String(val));
      },
      removeItem: (key: string) => {
        memoryStore.delete(key);
      },
      clear: () => {
        memoryStore.clear();
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("sanitizes valid http and https endpoints and strips trailing slashes", () => {
    expect(sanitizeEndpoint("http://localhost:8787///")).toBe("http://localhost:8787");
    expect(sanitizeEndpoint("https://autofabric.corp.internal:9443/api/v1/")).toBe(
      "https://autofabric.corp.internal:9443/api/v1",
    );
  });

  it("blocks pseudo-protocols and dangerous schemes, falling back to default endpoint", () => {
    expect(sanitizeEndpoint("javascript:alert(1)")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("javascript:/*--></title></style></textarea>*/<script>alert(1)</script>")).toBe(
      DEFAULT_AUTOFABRIC_ENDPOINT,
    );
    expect(sanitizeEndpoint("file:///etc/passwd")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("file://C:/Windows/System32/cmd.exe")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("data:text/html,<script>alert(1)</script>")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("blob:https://example.com/uuid")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("ftp://files.example.com/telemetry")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
  });

  it("falls back to default endpoint on empty, whitespace or invalid URL strings", () => {
    expect(sanitizeEndpoint("")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("   ")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("not-a-valid-url")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(sanitizeEndpoint("://missing-scheme")).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
  });

  it("reads and normalizes autofabric endpoint from localStorage", () => {
    localStorage.clear();
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    writeAutofabricEndpoint("http://localhost:8787///");
    expect(readAutofabricEndpoint()).toBe("http://localhost:8787");
  });

  it("safely neutralizes malicious or invalid values stored in localStorage on read", () => {
    localStorage.setItem("omb.autofabric.endpoint", "javascript:alert(1)");
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);

    localStorage.setItem("omb.autofabric.endpoint", "file:///etc/passwd");
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);

    localStorage.setItem("omb.autofabric.endpoint", "   ");
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
  });

  it("sanitizes writeAutofabricEndpoint inputs and falls back to default on invalid schemes", () => {
    const maliciousResult = writeAutofabricEndpoint("javascript:alert(document.domain)");
    expect(maliciousResult).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);

    const fileResult = writeAutofabricEndpoint("file:///C:/Users/frank/secret.key");
    expect(fileResult).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);

    const emptyResult = writeAutofabricEndpoint("");
    expect(emptyResult).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);
    expect(readAutofabricEndpoint()).toBe(DEFAULT_AUTOFABRIC_ENDPOINT);

    const validResult = writeAutofabricEndpoint("https://valid-endpoint.internal:8080/path///");
    expect(validResult).toBe("https://valid-endpoint.internal:8080/path");
    expect(readAutofabricEndpoint()).toBe("https://valid-endpoint.internal:8080/path");
  });
});

describe("FALLBACK_AUTOFABRIC_OVERVIEW", () => {
  it("provides complete 15-project matrix across the three domains", () => {
    const repos = FALLBACK_AUTOFABRIC_OVERVIEW.portfolio_matrix;
    expect(repos).toHaveLength(15);

    const infraRepos = repos.filter((r) => inferFactoryDomain(r.repo_full_name) === "infra");
    const fulfillRepos = repos.filter((r) => inferFactoryDomain(r.repo_full_name) === "fulfill");
    const appRepos = repos.filter((r) => inferFactoryDomain(r.repo_full_name) === "app");

    expect(infraRepos).toHaveLength(5);
    expect(fulfillRepos).toHaveLength(5);
    expect(appRepos).toHaveLength(5);

    expect(infraRepos.map((r) => r.repo_full_name)).toEqual([
      "infra/aer-runtime",
      "infra/relayon",
      "infra/autofabric",
      "infra/invari",
      "infra/aer-compiler",
    ]);

    expect(fulfillRepos.map((r) => r.repo_full_name)).toEqual([
      "fulfill/sheerid",
      "fulfill/chromium-profile-matrix",
      "fulfill/verisig",
      "fulfill/kirox",
      "fulfill/getotp",
    ]);

    expect(appRepos.map((r) => r.repo_full_name)).toEqual([
      "app/gptibo",
      "app/citeprime",
      "app/fetchinbox",
      "app/openmausbot",
      "app/citeprime-web",
    ]);
  });

  it("contains high-fidelity board decisions and steward cards", () => {
    expect(FALLBACK_AUTOFABRIC_OVERVIEW.board_decisions).toHaveLength(3);
    const decisionIds = FALLBACK_AUTOFABRIC_OVERVIEW.board_decisions.map((d) => d.decision_id);
    expect(decisionIds).toContain("dec-citeprime-t4");
    expect(decisionIds).toContain("dec-sheerid-bypass");
    expect(decisionIds).toContain("dec-aer-contract");

    expect(FALLBACK_AUTOFABRIC_OVERVIEW.steward_cards).toHaveLength(2);
    const stewardIds = FALLBACK_AUTOFABRIC_OVERVIEW.steward_cards.map((c) => c.card_id);
    expect(stewardIds).toContain("sc-sheerid-strike2");
    expect(stewardIds).toContain("sc-citeprime-mut");
  });

  it("includes gold certified AER scoreboard and dual-core CLI telemetry", () => {
    expect(FALLBACK_AUTOFABRIC_OVERVIEW.aer_scoreboard.certification_badge).toBe("AER-GOLD-CERTIFIED");
    expect(FALLBACK_AUTOFABRIC_OVERVIEW.aer_scoreboard.pass_to_pass_count).toBe(571);
    expect(FALLBACK_AUTOFABRIC_OVERVIEW.aer_scoreboard.fail_to_pass_count).toBe(42);

    expect(FALLBACK_AUTOFABRIC_OVERVIEW.cli_telemetry).toHaveLength(2);
    const cliNames = FALLBACK_AUTOFABRIC_OVERVIEW.cli_telemetry.map((c) => c.name);
    expect(cliNames).toContain("Claude Code (Anthropic)");
    expect(cliNames).toContain("Codex CLI (OpenAI)");
  });
});
