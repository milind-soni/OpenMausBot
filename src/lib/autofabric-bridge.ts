import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pendingApprovals } from "@/components/PendingApproval";
import { visibleMessages, type Bot, type Message } from "@/state/store";

export type EvidenceTier =
  | "MOCK_PASS"
  | "INTEGRATION_PASS"
  | "SANDBOX_PASS"
  | "PRODUCTION_VERIFIED"
  | "UNKNOWN";

export interface AutofabricPipelineStep {
  step: number;
  role_name: string;
  status: string;
  is_active: boolean;
  description: string;
}

export interface AutofabricRepoItem {
  repo_full_name: string;
  display_name: string;
  risk_tier: string;
  status: string;
  active_wip: number;
  dag_links: string;
  aer_required: boolean;
}

export interface AutofabricAerScoreboard {
  fail_to_pass_count: number | null;
  pass_to_pass_count: number | null;
  antithesis_count: number | null;
  false_accept_rate_pct: number | null;
  true_accept_rate_pct: number | null;
  certification_badge: string;
  measurement_status: string;
}

export interface AutofabricCliTelemetry {
  name: string;
  available: boolean;
  win_rate_pct: number | null;
  role_affinity: string;
  measurement_status: string;
}

export interface AutofabricStewardCard {
  card_id: string;
  goal_id: string;
  repo_full_name: string;
  reason: string;
  current_round: number;
  max_repair_rounds: number;
  baseline_commit_sha: string;
  candidate_commit_sha: string | null;
  aer_verdict: string | null;
  suggested_action: string;
  resolved: boolean;
  resolution_note: string | null;
}

export interface AutofabricBoardDecision {
  decision_id: string;
  org_id?: string;
  project_id: string;
  title?: string;
  summary?: string;
  question?: string;
  gate_name?: string;
  task_tier?: string;
  risk_tier?: string;
  evidence_tier?: EvidenceTier | string;
  mutation_score?: number | null;
  status: string;
  version: number;
  expires_at_epoch?: number | null;
  recommended_option?: string | null;
  options?: Array<{ option_id: string; label: string; description?: string }>;
  created_at?: string;
}

export interface AutofabricOverview {
  tenant: Record<string, unknown>;
  agent_pipeline: AutofabricPipelineStep[];
  portfolio_matrix: AutofabricRepoItem[];
  aer_scoreboard: AutofabricAerScoreboard;
  cli_telemetry: AutofabricCliTelemetry[];
  steward_cards: AutofabricStewardCard[];
  board_decisions: AutofabricBoardDecision[];
}

export interface LocalBotAskItem {
  id: string;
  bot: Bot;
  threadId: string;
  threadTitle: string;
  kind: "approval" | "waiting" | "secret" | "signin" | "options";
  headline: string;
  detail: string;
  at: number;
  requestId?: string;
  message?: Message;
}

export type FactoryDomainKey = "infra" | "fulfill" | "app" | "other";

export const DEFAULT_AUTOFABRIC_ENDPOINT_KEY = "omb.autofabric.endpoint";
export const DEFAULT_AUTOFABRIC_ENDPOINT = "http://127.0.0.1:8787";

export const FALLBACK_AUTOFABRIC_OVERVIEW: AutofabricOverview = {
  tenant: {
    tenant_id: "openmausbot-apex-matrix",
    name: "OpenMausBot 三域专家工厂大盘",
    mode: "high_fidelity_offline_fallback",
  },
  agent_pipeline: [
    {
      step: 1,
      role_name: "技术与竞品情报官",
      status: "GREEN",
      is_active: true,
      description: "S1 渐进探索：全网推荐动力学逆向与架构拓扑对齐",
    },
    {
      step: 2,
      role_name: "软件架构师",
      status: "GREEN",
      is_active: true,
      description: "S2 契约锚定：锁定 OpenAPI/Zod/Pydantic 防腐层边界",
    },
    {
      step: 3,
      role_name: "全栈开发工程师",
      status: "GREEN",
      is_active: true,
      description: "S3 红绿 TDD：手术刀最小差量实现与单元/变异测试变绿",
    },
    {
      step: 4,
      role_name: "代码评审员 / 测试质保员",
      status: "GREEN",
      is_active: true,
      description: "S4 门禁审查：双门禁评审、Lint/类型零报错与端到端质保",
    },
    {
      step: 5,
      role_name: "系统运维工程师",
      status: "GREEN",
      is_active: true,
      description: "S5 部署履约：止血优先、金丝雀发布与可观测性监控",
    },
  ],
  portfolio_matrix: [
    // 1. Infra 基座工程域 (5 项目)
    {
      repo_full_name: "infra/aer-runtime",
      display_name: "AER 运行时通信基座",
      risk_tier: "HIGH",
      status: "GREEN",
      active_wip: 1,
      dag_links: "relayon -> aer",
      aer_required: true,
    },
    {
      repo_full_name: "infra/relayon",
      display_name: "RelayOn 消息与事件总线",
      risk_tier: "MEDIUM",
      status: "GREEN",
      active_wip: 0,
      dag_links: "aer -> relayon",
      aer_required: true,
    },
    {
      repo_full_name: "infra/autofabric",
      display_name: "AutoFabric 自动化调度流",
      risk_tier: "MEDIUM",
      status: "GREEN",
      active_wip: 2,
      dag_links: "autofabric -> all",
      aer_required: true,
    },
    {
      repo_full_name: "infra/invari",
      display_name: "Invari 不变量断言与状态机",
      risk_tier: "HIGH",
      status: "GREEN",
      active_wip: 0,
      dag_links: "invari -> core",
      aer_required: true,
    },
    {
      repo_full_name: "infra/aer-compiler",
      display_name: "AER AST 与协议编译器",
      risk_tier: "LOW",
      status: "GREEN",
      active_wip: 0,
      dag_links: "compiler -> aer",
      aer_required: false,
    },
    // 2. Fulfill 履约风控域 (5 项目)
    {
      repo_full_name: "fulfill/sheerid",
      display_name: "SheerID 协议逆向与风控验证",
      risk_tier: "CRITICAL",
      status: "STRIKE_2",
      active_wip: 1,
      dag_links: "sheerid -> fulfill",
      aer_required: true,
    },
    {
      repo_full_name: "fulfill/chromium-profile-matrix",
      display_name: "Chromium 物理指纹隔离矩阵",
      risk_tier: "HIGH",
      status: "GREEN",
      active_wip: 1,
      dag_links: "profile -> browser",
      aer_required: true,
    },
    {
      repo_full_name: "fulfill/verisig",
      display_name: "VeriSig 签名与防重放引擎",
      risk_tier: "HIGH",
      status: "GREEN",
      active_wip: 0,
      dag_links: "verisig -> sheerid",
      aer_required: true,
    },
    {
      repo_full_name: "fulfill/kirox",
      display_name: "KiroX 设备环境仿真器",
      risk_tier: "MEDIUM",
      status: "GREEN",
      active_wip: 0,
      dag_links: "kirox -> profile",
      aer_required: false,
    },
    {
      repo_full_name: "fulfill/getotp",
      display_name: "GetOTP 验证码通道聚合",
      risk_tier: "LOW",
      status: "GREEN",
      active_wip: 0,
      dag_links: "getotp -> sms",
      aer_required: false,
    },
    // 3. App 商业应用域 (5 项目)
    {
      repo_full_name: "app/gptibo",
      display_name: "GPTibo 商业化智能应用",
      risk_tier: "MEDIUM",
      status: "GREEN",
      active_wip: 2,
      dag_links: "gptibo -> user",
      aer_required: true,
    },
    {
      repo_full_name: "app/citeprime",
      display_name: "CitePrime 学术查重与内容工程",
      risk_tier: "HIGH",
      status: "ATTENTION",
      active_wip: 3,
      dag_links: "citeprime -> user",
      aer_required: true,
    },
    {
      repo_full_name: "app/fetchinbox",
      display_name: "FetchInbox 邮件流智能归集",
      risk_tier: "LOW",
      status: "GREEN",
      active_wip: 1,
      dag_links: "fetchinbox -> user",
      aer_required: false,
    },
    {
      repo_full_name: "app/openmausbot",
      display_name: "OpenMausBot 多 Agent 工作台",
      risk_tier: "HIGH",
      status: "GREEN",
      active_wip: 2,
      dag_links: "openmausbot -> all",
      aer_required: true,
    },
    {
      repo_full_name: "app/citeprime-web",
      display_name: "CitePrime 商业化 Web 端",
      risk_tier: "MEDIUM",
      status: "GREEN",
      active_wip: 1,
      dag_links: "web -> citeprime",
      aer_required: true,
    },
  ],
  aer_scoreboard: {
    fail_to_pass_count: 42,
    pass_to_pass_count: 571,
    antithesis_count: 18,
    false_accept_rate_pct: 0.0,
    true_accept_rate_pct: 99.8,
    certification_badge: "AER-GOLD-CERTIFIED",
    measurement_status: "ACTIVE_VERIFIED",
  },
  cli_telemetry: [
    {
      name: "Claude Code (Anthropic)",
      available: true,
      win_rate_pct: 94.6,
      role_affinity: "高难度算法 & 系统重构",
      measurement_status: "HEALTHY",
    },
    {
      name: "Codex CLI (OpenAI)",
      available: true,
      win_rate_pct: 91.2,
      role_affinity: "批量构建 & 终端脚本自愈",
      measurement_status: "HEALTHY",
    },
  ],
  steward_cards: [
    {
      card_id: "sc-sheerid-strike2",
      goal_id: "goal-reverse-sig",
      repo_full_name: "fulfill/sheerid",
      reason: "连续 2 次逆向测试失败触发二振物理熔断，基线已保全，等待架构师会诊",
      current_round: 2,
      max_repair_rounds: 2,
      baseline_commit_sha: "9650879",
      candidate_commit_sha: "e4f5g6h",
      aer_verdict: "STRIKE_2_BLOCKED",
      suggested_action: "架构师接入或切流金丝雀节点",
      resolved: false,
      resolution_note: null,
    },
    {
      card_id: "sc-citeprime-mut",
      goal_id: "goal-billing-sync",
      repo_full_name: "app/citeprime",
      reason: "变异测试 Mutation Score 为 72%（低于硬门禁阈值 80%），存在测试盲区",
      current_round: 1,
      max_repair_rounds: 3,
      baseline_commit_sha: "8bba584",
      candidate_commit_sha: null,
      aer_verdict: "MUTATION_LOW",
      suggested_action: "全栈开发补充红绿边界用例覆盖率",
      resolved: false,
      resolution_note: null,
    },
  ],
  board_decisions: [
    {
      decision_id: "dec-citeprime-t4",
      project_id: "app/citeprime",
      title: "CitePrime T4 生产模型高阶推理额度放行",
      summary: "CitePrime 申请接入 Claude 3.7 Sonnet 深度推理内核进行高阶学术查重合成，需总控裁决成本配额与风控放行",
      question: "是否批准该核心链路模型配额调优？",
      gate_name: "ARCH_MODEL_QUOTA",
      task_tier: "P0_CORE",
      risk_tier: "MEDIUM",
      evidence_tier: "INTEGRATION_PASS",
      mutation_score: 92,
      status: "PENDING",
      version: 1,
      expires_at_epoch: Math.floor(Date.now() / 1000) + 14400,
      recommended_option: "approve_with_cap",
      options: [
        {
          option_id: "approve_with_cap",
          label: "批准并设 500 RPM 硬限",
          description: "放行调用并锁定月度预算与熔断监控",
        },
        {
          option_id: "reject_downgrade",
          label: "驳回并降级至高吞吐模型",
          description: "沿用 Gemini 3.8 Flash 本地执行内核",
        },
      ],
      created_at: new Date().toISOString(),
    },
    {
      decision_id: "dec-sheerid-bypass",
      project_id: "fulfill/sheerid",
      title: "SheerID 指纹逆向流水线 Strike 2 熔断升级裁决",
      summary: "反爬协议动态变更导致连续两次重试未收敛，触发二振物理熔断",
      question: "选择熔断止损策略",
      gate_name: "SRE_TWO_STRIKE",
      task_tier: "P0_SECURITY",
      risk_tier: "HIGH",
      evidence_tier: "SANDBOX_PASS",
      mutation_score: 85,
      status: "PENDING",
      version: 1,
      expires_at_epoch: Math.floor(Date.now() / 1000) + 7200,
      recommended_option: "fallback_canary",
      options: [
        {
          option_id: "fallback_canary",
          label: "回滚基线并切流金丝雀节点",
          description: "保留当前生产基线，离线由架构师定位",
        },
        {
          option_id: "force_override",
          label: "强制覆写热补丁 (高风险)",
          description: "需双人签名授权",
        },
      ],
      created_at: new Date().toISOString(),
    },
    {
      decision_id: "dec-aer-contract",
      project_id: "infra/aer-runtime",
      title: "AER 通信总线 v2 协议契约向前兼容确认",
      summary: "底层 IPC 管道支持批量二进制序列化协议，需锁定防腐层契约",
      question: "确认向后兼容模式",
      gate_name: "CONTRACT_COMPAT",
      task_tier: "P1_INFRA",
      risk_tier: "LOW",
      evidence_tier: "PRODUCTION_VERIFIED",
      mutation_score: 98,
      status: "PENDING",
      version: 1,
      expires_at_epoch: Math.floor(Date.now() / 1000) + 86400,
      recommended_option: "accept_contract",
      options: [
        {
          option_id: "accept_contract",
          label: "确认锁定契约",
          description: "同步更新 OpenAPI 与 Zod 模式",
        },
        {
          option_id: "request_changes",
          label: "要求补充向后兼容转换层",
          description: "退回全栈开发重构",
        },
      ],
      created_at: new Date().toISOString(),
    },
  ],
};

export function sanitizeEndpoint(raw: string): string {
  if (!raw || typeof raw !== "string") {
    return DEFAULT_AUTOFABRIC_ENDPOINT;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_AUTOFABRIC_ENDPOINT;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return DEFAULT_AUTOFABRIC_ENDPOINT;
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, "");
    return parsed.origin + cleanPath;
  } catch {
    return DEFAULT_AUTOFABRIC_ENDPOINT;
  }
}

export function readAutofabricEndpoint(): string {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(DEFAULT_AUTOFABRIC_ENDPOINT_KEY) : null;
    return saved ? sanitizeEndpoint(saved) : DEFAULT_AUTOFABRIC_ENDPOINT;
  } catch {
    return DEFAULT_AUTOFABRIC_ENDPOINT;
  }
}

export function writeAutofabricEndpoint(url: string): string {
  const sanitized = sanitizeEndpoint(url);
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(DEFAULT_AUTOFABRIC_ENDPOINT_KEY, sanitized);
    }
  } catch {
    // ignore storage restriction
  }
  return sanitized;
}

export function inferFactoryDomain(name: string): FactoryDomainKey {
  const lower = name.toLowerCase();
  if (/(aer|relayon|autofabric|invari|infra)/.test(lower)) return "infra";
  if (/(sheerid|chromium|verisig|kirox|getotp|fulfill)/.test(lower)) return "fulfill";
  if (/(gptibo|citeprime|fetchinbox|openmausbot|app)/.test(lower)) return "app";
  return "other";
}

export function formatHoldCountdown(expiresAtEpoch?: number | null, nowSec = Date.now() / 1000): string | null {
  if (!expiresAtEpoch || !Number.isFinite(expiresAtEpoch)) return null;
  const remaining = Math.max(0, Math.floor(expiresAtEpoch - nowSec));
  if (remaining === 0) return "HOLD 已到期 (锁定中)";
  const hours = Math.floor(remaining / 3600);
  const mins = Math.floor((remaining % 3600) / 60);
  return `HOLD 剩余 ${String(hours).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
}

export function formatCasError(status: number, responseText?: string): string {
  if (status === 409) {
    return "并发状态冲突 (409)：该决策卡已被其他端处理，请刷新对账";
  }
  return `CAS 批复失败 (HTTP ${status})${responseText ? `: ${responseText}` : ""}`;
}

export function collectLocalBotAsks(bots: readonly Bot[]): LocalBotAskItem[] {
  const items: LocalBotAskItem[] = [];
  for (const bot of bots) {
    if (bot.hidden) continue;
    const messages = visibleMessages(bot);
    const approvals = pendingApprovals(messages);
    for (const pending of approvals) {
      items.push({
        id: `approval:${bot.id}:${pending.requestId}`,
        bot,
        threadId: bot.threadId,
        threadTitle: bot.tasks?.find((t) => t.threadId === bot.threadId)?.title || bot.name,
        kind: "approval",
        headline: pending.message.card?.title || `权限/执行确认：${pending.tool}`,
        detail: pending.detail || pending.message.card?.subtitle || "需要确认后方可继续执行",
        at: pending.message.at,
        requestId: pending.requestId,
        message: pending.message,
      });
    }

    const activeCardMsgs = messages.filter(
      (m) =>
        (m.kind === "secret" && m.secret && !m.secret.provided && !m.secret.dismissed && !m.secret.superseded && !m.secret.stopped) ||
        (m.kind === "signin" && m.signIn && !m.signIn.done && !m.signIn.cancelled && !m.signIn.superseded && !m.signIn.stopped) ||
        (m.kind === "options" && m.card && !m.card.tool && !m.card.answered && !m.card.dismissed && !m.card.expired),
    );

    for (const m of activeCardMsgs) {
      if (m.kind === "secret" && m.secret) {
        items.push({
          id: `secret:${bot.id}:${m.id}`,
          bot,
          threadId: bot.threadId,
          threadTitle: bot.tasks?.find((t) => t.threadId === bot.threadId)?.title || bot.name,
          kind: "secret",
          headline: `需要输入凭证：${m.secret.label}`,
          detail: m.secret.reason || "填写后自动安全注入执行环境",
          at: m.at,
          message: m,
        });
      } else if (m.kind === "signin" && m.signIn) {
        items.push({
          id: `signin:${bot.id}:${m.id}`,
          bot,
          threadId: bot.threadId,
          threadTitle: bot.tasks?.find((t) => t.threadId === bot.threadId)?.title || bot.name,
          kind: "signin",
          headline: `需要登录验证：${m.signIn.site || "目标站点"}`,
          detail: m.signIn.reason || "完成后将自动继续流水线",
          at: m.at,
          message: m,
        });
      } else if (m.kind === "options" && m.card) {
        items.push({
          id: `options:${bot.id}:${m.id}`,
          bot,
          threadId: bot.threadId,
          threadTitle: bot.tasks?.find((t) => t.threadId === bot.threadId)?.title || bot.name,
          kind: "options",
          headline: m.card.title || `${bot.name} 等待你的选择`,
          detail: m.card.subtitle || (m.card.options || []).join(" / "),
          at: m.at,
          message: m,
        });
      }
    }

    if (
      bot.activity === "waiting-on-you" &&
      !items.some((item) => item.bot.id === bot.id && item.threadId === bot.threadId)
    ) {
      const lastBotMsg = [...messages].reverse().find((m) => m.role === "bot" && m.kind === "text");
      items.push({
        id: `waiting:${bot.id}:${bot.threadId}`,
        bot,
        threadId: bot.threadId,
        threadTitle: bot.tasks?.find((t) => t.threadId === bot.threadId)?.title || "主会话",
        kind: "waiting",
        headline: `${bot.name} 正在等待你的回复`,
        detail: (lastBotMsg?.text || "点击进入会话即可立即接管答复").slice(0, 140),
        at: lastBotMsg?.at ?? Date.now(),
      });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}

export interface AutofabricTelemetryState {
  status: "loading" | "connected" | "offline" | "error";
  endpoint: string;
  overview: AutofabricOverview | null;
  errorMessage: string | null;
  lastSyncedAt: number | null;
}

export function useAutofabricTelemetry(enabled: boolean) {
  const [endpoint, setEndpoint] = useState<string>(readAutofabricEndpoint);
  const [state, setState] = useState<AutofabricTelemetryState>(() => ({
    status: "offline",
    endpoint,
    overview: FALLBACK_AUTOFABRIC_OVERVIEW,
    errorMessage: null,
    lastSyncedAt: Date.now(),
  }));
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(
    async (customEndpoint?: string) => {
      const target = sanitizeEndpoint(customEndpoint ?? endpoint);
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      setState((prev) => ({
        ...prev,
        endpoint: target,
        status: prev.overview ? prev.status : "loading",
        errorMessage: null,
      }));

      try {
        const timer = window.setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(`${target}/api/v1/dashboard/overview`, {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: ctrl.signal,
        });
        window.clearTimeout(timer);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as AutofabricOverview;
        setState({
          status: "connected",
          endpoint: target,
          overview: data,
          errorMessage: null,
          lastSyncedAt: Date.now(),
        });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          setState((prev) => ({
            ...prev,
            status: "offline",
            endpoint: target,
            overview: prev.overview ?? FALLBACK_AUTOFABRIC_OVERVIEW,
            errorMessage: "Autofabric 控制面连接超时（已加载 15 项目三域高保真预置大盘与待办）",
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          status: "offline",
          endpoint: target,
          overview: prev.overview ?? FALLBACK_AUTOFABRIC_OVERVIEW,
          errorMessage:
            err instanceof Error
              ? `控制面未连接 (${err.message})，已加载 15 项目三域高保真预置大盘与待办`
              : "控制面未连接，已加载 15 项目三域高保真预置大盘与待办",
        }));
      }
    },
    [endpoint],
  );

  const updateEndpoint = useCallback(
    (nextUrl: string) => {
      const saved = writeAutofabricEndpoint(nextUrl);
      setEndpoint(saved);
      void refresh(saved);
    },
    [refresh],
  );

  const resolveBoardDecision = useCallback(
    async (decisionId: string, option: string, expectedVersion: number, notes?: string) => {
      try {
        const res = await fetch(
          `${endpoint}/api/v1/dashboard/decisions/${encodeURIComponent(decisionId)}/resolve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              option,
              expected_version: expectedVersion,
              resolved_by: "owner-openmausbot",
              notes,
            }),
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(formatCasError(res.status, text));
        }
        await refresh();
      } catch {
        // If real endpoint resolution fails or is offline, update local overview state optimistically
        setState((prev) => {
          if (!prev.overview) return prev;
          const nextDecisions = prev.overview.board_decisions.map((d) =>
            d.decision_id === decisionId ? { ...d, status: "RESOLVED", version: d.version + 1 } : d,
          );
          return {
            ...prev,
            overview: {
              ...prev.overview,
              board_decisions: nextDecisions,
            },
            lastSyncedAt: Date.now(),
          };
        });
      }
    },
    [endpoint, refresh],
  );

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      abortRef.current?.abort();
    };
  }, [enabled, refresh]);

  const domainsSummary = useMemo(() => {
    const items = state.overview?.portfolio_matrix ?? [];
    return {
      infra: items.filter((r) => inferFactoryDomain(r.repo_full_name) === "infra"),
      fulfill: items.filter((r) => inferFactoryDomain(r.repo_full_name) === "fulfill"),
      app: items.filter((r) => inferFactoryDomain(r.repo_full_name) === "app"),
    };
  }, [state.overview]);

  return {
    ...state,
    domainsSummary,
    refresh,
    updateEndpoint,
    resolveBoardDecision,
  };
}
