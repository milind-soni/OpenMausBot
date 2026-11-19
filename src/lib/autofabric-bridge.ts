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
  const [state, setState] = useState<AutofabricTelemetryState>({
    status: "loading",
    endpoint,
    overview: null,
    errorMessage: null,
    lastSyncedAt: null,
  });
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
            errorMessage: "Autofabric 控制面连接超时（仅展示本地实时状态，严禁伪造门禁数据）",
          }));
          return;
        }
        setState((prev) => ({
          ...prev,
          status: "offline",
          endpoint: target,
          errorMessage:
            err instanceof Error
              ? `控制面未连接 (${err.message})，当前处于只读降级态`
              : "控制面未连接",
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
