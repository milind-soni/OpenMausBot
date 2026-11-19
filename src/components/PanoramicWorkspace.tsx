import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  Cpu,
  Inbox,
  Layers,
  RefreshCw,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";
import {
  collectLocalBotAsks,
  formatHoldCountdown,
  inferFactoryDomain,
  useAutofabricTelemetry,
  type AutofabricBoardDecision,
  type AutofabricStewardCard,
  type EvidenceTier,
  type LocalBotAskItem,
} from "@/lib/autofabric-bridge";
import { cn } from "@/lib/cn";
import { openBot, openThread, useStore, type Bot } from "@/state/store";
import { useShowThreads } from "@/lib/thread-preferences";
import { BotAvatar } from "./Avatar";

interface PanoramicWorkspaceProps {
  onOpenChat?: (botId?: string) => void;
  defaultTab?: "inbox" | "matrix";
}

function evidenceBadgeStyle(tier?: string): { label: string; cls: string } {
  switch (tier as EvidenceTier) {
    case "PRODUCTION_VERIFIED":
      return {
        label: "PRODUCTION_VERIFIED",
        cls: "border-success/35 bg-success/10 text-success",
      };
    case "SANDBOX_PASS":
      return {
        label: "SANDBOX_PASS",
        cls: "border-success/30 bg-success/10 text-success",
      };
    case "INTEGRATION_PASS":
      return {
        label: "INTEGRATION_PASS",
        cls: "border-accent/35 bg-accent/10 text-accent",
      };
    case "MOCK_PASS":
      return {
        label: "MOCK_PASS (仅允许 Draft PR)",
        cls: "border-warning/40 bg-warning/10 text-warning",
      };
    default:
      return {
        label: tier && tier.trim() ? tier : "UNKNOWN (未实测)",
        cls: "border-hairline bg-inset text-ink-secondary",
      };
  }
}

function statusDotClass(bot: Bot): { dot: string; label: string } {
  if (bot.activity === "waiting-on-you") {
    return { dot: "bg-warning", label: "需拍板" };
  }
  if (bot.busy) {
    return { dot: "bg-accent animate-pulse motion-reduce:animate-none", label: "运行中" };
  }
  if (bot.unread) {
    return { dot: "bg-accent", label: "未读" };
  }
  return { dot: "bg-success", label: "就绪" };
}

export function PanoramicWorkspace({ onOpenChat, defaultTab = "inbox" }: PanoramicWorkspaceProps) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [activeTab, setActiveTab] = useState<"inbox" | "matrix">(defaultTab);
  const [domainFilter, setDomainFilter] = useState<"all" | "infra" | "fulfill" | "app">("all");
  const [editingEndpoint, setEditingEndpoint] = useState(false);
  const [endpointDraft, setEndpointDraft] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [resolvedIds, setResolvedIds] = useState<Record<string, string>>({});
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));

  const telemetry = useAutofabricTelemetry(true);

  useEffect(() => {
    setEndpointDraft(telemetry.endpoint);
  }, [telemetry.endpoint]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowTick(Math.floor(Date.now() / 1000));
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const bots = useMemo(() => state.bots.filter((b) => !b.hidden), [state.bots]);
  const localAsks = useMemo(() => collectLocalBotAsks(bots), [bots]);

  const activeBoardDecisions = useMemo(() => {
    const raw = telemetry.overview?.board_decisions ?? [];
    return raw.filter(
      (card) =>
        !resolvedIds[card.decision_id] &&
        !["RESOLVED", "APPROVED", "REJECTED", "CONSUMED", "CANCELLED"].includes(
          String(card.status).toUpperCase(),
        ),
    );
  }, [telemetry.overview?.board_decisions, resolvedIds]);

  const activeStewardCards = useMemo(() => {
    return (telemetry.overview?.steward_cards ?? []).filter((c) => !c.resolved);
  }, [telemetry.overview?.steward_cards]);

  const totalActionCount =
    activeBoardDecisions.length + activeStewardCards.length + localAsks.length;

  const handleTakeoverBot = useCallback(
    (bot: Bot, threadId?: string) => {
      if (threadId && threadId !== bot.threadId) {
        openThread(dispatch, { botId: bot.id, threadId }, state, showThreads);
      } else {
        openBot(dispatch, bot, showThreads);
      }
      onOpenChat?.(bot.id);
    },
    [dispatch, onOpenChat, showThreads, state],
  );

  const handleResolveBoard = async (card: AutofabricBoardDecision, option: string) => {
    setResolveError(null);
    setResolvingId(card.decision_id);
    setResolvedIds((prev) => ({ ...prev, [card.decision_id]: option }));
    try {
      await telemetry.resolveBoardDecision(card.decision_id, option, card.version);
    } catch (err) {
      setResolvedIds((prev) => {
        const next = { ...prev };
        delete next[card.decision_id];
        return next;
      });
      setResolveError(err instanceof Error ? err.message : String(err));
      void telemetry.refresh();
    } finally {
      setResolvingId(null);
    }
  };

  const filteredPortfolio = useMemo(() => {
    const items = telemetry.overview?.portfolio_matrix ?? [];
    if (domainFilter === "all") return items;
    return items.filter((item) => inferFactoryDomain(item.repo_full_name) === domainFilter);
  }, [telemetry.overview?.portfolio_matrix, domainFilter]);

  const runningBotsCount = bots.filter((b) => Boolean(b.busy)).length;
  const waitingBotsCount = bots.filter((b) => b.activity === "waiting-on-you").length;

  return (
    <div
      data-look="factory-cockpit"
      className="flex h-full w-full flex-col overflow-hidden bg-app text-ink"
    >
      {/* Top Bar: Factory Mode Switcher + Status + Esc Return */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-edge bg-panel/80 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            role="tablist"
            aria-label="自动工厂视图切换"
            className="inline-flex rounded-xl border border-hairline/70 bg-inset p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "inbox"}
              onClick={() => setActiveTab("inbox")}
              className={cn(
                "flex items-center gap-1.5 rounded-[10px] px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                activeTab === "inbox"
                  ? "bg-card text-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              <Inbox size={13} aria-hidden="true" />
              <span>待我处理</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.2 text-[10px] font-semibold tabular-nums",
                  totalActionCount > 0
                    ? "bg-warning/15 text-warning"
                    : "bg-raised text-ink-tertiary",
                )}
              >
                {totalActionCount}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "matrix"}
              onClick={() => setActiveTab("matrix")}
              className={cn(
                "flex items-center gap-1.5 rounded-[10px] px-3 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                activeTab === "matrix"
                  ? "bg-card text-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink",
              )}
            >
              <Layers size={13} aria-hidden="true" />
              <span>三域工厂大盘</span>
            </button>
          </div>

          {/* Control-plane truth badge (no fake green) */}
          <div className="hidden items-center gap-1.5 rounded-full border border-hairline/60 bg-card px-2.5 py-1 text-[11px] text-ink-secondary sm:flex">
            <span
              className={cn(
                "size-1.5 rounded-full",
                telemetry.status === "connected"
                  ? "bg-success"
                  : telemetry.status === "loading"
                    ? "bg-accent animate-pulse"
                    : "bg-warning",
              )}
            />
            <span className="truncate">
              {telemetry.status === "connected"
                ? "Autofabric PG 控制面在线"
                : telemetry.status === "loading"
                  ? "连接 Autofabric 控制面中…"
                  : "控制面未连接 (只读本地降级)"}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void telemetry.refresh()}
            className="flex size-7 items-center justify-center rounded-full border border-hairline/60 bg-card text-ink-secondary transition hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            title="刷新 Autofabric 控制面遥测"
            aria-label="刷新 Autofabric 控制面遥测"
          >
            <RefreshCw
              size={13}
              className={telemetry.status === "loading" ? "animate-spin" : undefined}
            />
          </button>

          <button
            type="button"
            onClick={() => setEditingEndpoint((prev) => !prev)}
            className="hidden items-center gap-1 rounded-full border border-hairline/60 bg-card px-2.5 py-1 text-[11px] text-ink-secondary transition hover:bg-raised hover:text-ink md:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            title="配置 Autofabric 控制面地址"
          >
            <Server size={12} />
            <span>{telemetry.endpoint.replace(/^https?:\/\//, "")}</span>
          </button>

          <button
            type="button"
            onClick={() => onOpenChat?.()}
            className="flex items-center gap-1.5 rounded-full border border-hairline/70 bg-card px-3 py-1 text-[12px] font-medium text-ink transition hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            title="返回当前对话视图 (Esc)"
          >
            <ArrowLeft size={13} />
            <span>返回对话</span>
            <kbd className="rounded bg-inset px-1 py-0.2 font-mono text-[10px] text-ink-tertiary">
              Esc
            </kbd>
          </button>
        </div>
      </header>

      {/* Optional inline endpoint editor */}
      {editingEndpoint && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            telemetry.updateEndpoint(endpointDraft);
            setEditingEndpoint(false);
          }}
          className="flex flex-wrap items-center gap-2 border-b border-edge bg-inset px-4 py-2 text-[12px]"
        >
          <span className="font-medium text-ink-secondary">Autofabric 遥测地址：</span>
          <input
            type="url"
            value={endpointDraft}
            onChange={(e) => setEndpointDraft(e.target.value)}
            placeholder="http://127.0.0.1:8787"
            className="min-w-[220px] flex-1 rounded-lg border border-hairline bg-card px-2.5 py-1 text-[12px] text-ink outline-none focus:ring-2 focus:ring-accent/60"
          />
          <button
            type="submit"
            className="rounded-lg bg-accent px-3 py-1 text-[12px] font-medium text-[var(--color-accent-ink)] hover:brightness-110"
          >
            保存并重连
          </button>
          <button
            type="button"
            onClick={() => setEditingEndpoint(false)}
            className="rounded-lg border border-hairline bg-card px-2.5 py-1 text-[12px] text-ink-secondary hover:text-ink"
          >
            取消
          </button>
        </form>
      )}

      {/* Main Split: Quiet Left Expert/Project Waterline + Focused Center Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Quiet Waterline (248px, Apple Notes / v4.3.0 flat single-layer list) */}
        <aside className="hidden w-[248px] shrink-0 flex-col border-r border-edge bg-panel/60 lg:flex">
          <div className="flex items-center justify-between px-3.5 py-2.5 text-[11px] font-semibold text-ink-tertiary">
            <span>共享专家中台 ({bots.length})</span>
            <span>点击即时接管</span>
          </div>

          <div className="flex-1 space-y-1 overflow-y-auto px-2 pb-2">
            {bots.map((bot) => {
              const st = statusDotClass(bot);
              const isSelected = bot.id === state.selectedId;
              return (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => handleTakeoverBot(bot)}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                    isSelected
                      ? "bg-raised text-ink"
                      : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                  )}
                >
                  <BotAvatar
                    bot={{
                      name: bot.name,
                      color: bot.color,
                      avatarUrl: bot.avatarUrl,
                      avatarCrop: bot.avatarCrop,
                      avatarZoom: bot.avatarZoom,
                      avatarFocusX: bot.avatarFocusX,
                      avatarFocusY: bot.avatarFocusY,
                      mascotBody: bot.mascotBody,
                      mascotFaceColor: bot.mascotFaceColor,
                    }}
                    size={22}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-ink">
                        {bot.name}
                      </span>
                      <span
                        className={cn("size-2 shrink-0 rounded-full", st.dot)}
                        title={st.label}
                        aria-label={st.label}
                      />
                    </div>
                    <div className="truncate text-[10.5px] text-ink-tertiary">
                      {bot.modelSelection?.model || "未配置模型"} · {st.label}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="border-t border-edge px-3 py-2 text-[10.5px] text-ink-tertiary">
            <div className="flex items-center justify-between">
              <span>运行中 {runningBotsCount}</span>
              <span>待拍板 {waitingBotsCount}</span>
              <span>就绪 {Math.max(0, bots.length - runningBotsCount - waitingBotsCount)}</span>
            </div>
          </div>
        </aside>

        {/* Center Main Content */}
        <section className="flex min-w-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {/* Control-plane offline notice (never fakes green) */}
          {telemetry.status === "offline" && telemetry.errorMessage && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warning/35 bg-warning/10 px-4 py-2.5 text-[12px] text-warning">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} className="shrink-0" />
                <span>{telemetry.errorMessage}</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setEditingEndpoint(true)}
                  className="rounded-lg border border-warning/35 bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-raised"
                >
                  修改地址
                </button>
                <button
                  type="button"
                  onClick={() => void telemetry.refresh()}
                  className="rounded-lg border border-warning/40 bg-card px-2.5 py-1 text-[11px] font-semibold text-warning hover:bg-raised"
                >
                  重试连接
                </button>
              </div>
            </div>
          )}

          {resolveError && (
            <div className="mb-4 flex items-center justify-between gap-2 rounded-2xl border border-danger/35 bg-danger/10 px-4 py-2.5 text-[12px] text-danger">
              <span>{resolveError}</span>
              <button
                type="button"
                onClick={() => setResolveError(null)}
                className="text-[11px] underline"
              >
                关闭
              </button>
            </div>
          )}

          {activeTab === "inbox" ? (
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
              {/* Quiet Status Strip */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-hairline/70 bg-panel px-4 py-2.5 text-[12px] text-ink-secondary">
                <div className="flex items-center gap-2">
                  <Sparkles size={14} className="text-accent" />
                  <span>
                    问题主动排队找人：当前共有{" "}
                    <strong className="font-semibold text-ink">{totalActionCount}</strong>{" "}
                    项待拍板/待接管；其余线程水面下静默运行（{runningBotsCount} 活跃）。
                  </span>
                </div>
                <span className="font-mono text-[11px] text-ink-tertiary">
                  唯一权威：Autofabric PG + OpenMausBot 实时会话
                </span>
              </div>

              {/* Loading Skeleton (State 2: 1:1 CLS=0) */}
              {telemetry.status === "loading" && (
                <div className="space-y-3" aria-busy="true" aria-label="正在加载决策卡">
                  <div className="h-[116px] w-full animate-pulse rounded-2xl border border-hairline/50 bg-panel" />
                  <div className="h-[116px] w-full animate-pulse rounded-2xl border border-hairline/50 bg-panel" />
                </div>
              )}

              {/* 1. Autofabric Board Decision Cards (CAS + EvidenceTier + 48h HOLD) */}
              {activeBoardDecisions.map((card) => {
                const ev = evidenceBadgeStyle(card.evidence_tier);
                const holdText = formatHoldCountdown(card.expires_at_epoch, nowTick);
                const isSubmitting = resolvingId === card.decision_id;
                const options =
                  card.options && card.options.length > 0
                    ? card.options
                    : [
                        { option_id: "APPROVE", label: "签发放行凭证" },
                        { option_id: "HOLD", label: "保持 HOLD" },
                        { option_id: "REJECT", label: "打回重做" },
                      ];
                return (
                  <article
                    key={card.decision_id}
                    className="rounded-2xl border border-hairline/80 border-l-4 border-l-warning bg-card p-4 shadow-sm transition-shadow hover:shadow-md"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-semibold text-accent">
                          {card.task_tier || "BOARD_GATE"} · {card.project_id}
                        </span>
                        <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-medium", ev.cls)}>
                          {ev.label}
                        </span>
                        {typeof card.mutation_score === "number" && (
                          <span className="rounded-md bg-inset px-2 py-0.5 font-mono text-[11px] text-ink-secondary">
                            Mutation {card.mutation_score.toFixed(2)}
                          </span>
                        )}
                      </div>
                      {holdText && (
                        <span className="flex items-center gap-1 font-mono text-[11px] text-ink-tertiary">
                          <Clock size={12} />
                          {holdText}
                        </span>
                      )}
                    </div>

                    <h3 className="mt-2.5 text-[14.5px] font-semibold leading-snug text-ink">
                      {card.question || card.title || card.summary || `决策卡 ${card.decision_id}`}
                    </h3>
                    {card.summary && card.question && (
                      <p className="mt-1 text-[12.5px] text-ink-secondary">{card.summary}</p>
                    )}

                    <div className="mt-3.5 flex flex-wrap items-center gap-2">
                      {options.map((opt) => {
                        const isRec =
                          card.recommended_option && card.recommended_option === opt.option_id;
                        return (
                          <button
                            key={opt.option_id}
                            type="button"
                            disabled={isSubmitting}
                            onClick={() => void handleResolveBoard(card, opt.option_id)}
                            className={cn(
                              "rounded-xl px-3 py-1.5 text-[12px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:cursor-not-allowed disabled:opacity-50",
                              isRec || opt.option_id === "APPROVE"
                                ? "bg-ink text-app hover:brightness-110"
                                : "border border-hairline bg-raised text-ink hover:bg-raised-hover",
                            )}
                          >
                            {isSubmitting ? "提交 CAS 批复中..." : opt.label}
                            {isRec ? " (推荐)" : ""}
                          </button>
                        );
                      })}
                    </div>
                  </article>
                );
              })}

              {/* 2. Autofabric Chinese Steward Cards (Strike / Retry / Failover) */}
              {activeStewardCards.map((sc: AutofabricStewardCard) => (
                <article
                  key={sc.card_id}
                  className="rounded-2xl border border-hairline/80 border-l-4 border-l-danger bg-card p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-semibold text-danger">
                        STEWARD · {sc.repo_full_name}
                      </span>
                      <span className="rounded-md bg-inset px-2 py-0.5 font-mono text-[11px] text-ink-secondary">
                        Round {sc.current_round}/{sc.max_repair_rounds}
                      </span>
                      {sc.aer_verdict && (
                        <span className="rounded-md bg-inset px-2 py-0.5 text-[11px] text-ink-secondary">
                          AER: {sc.aer_verdict}
                        </span>
                      )}
                    </div>
                    <span className="font-mono text-[10.5px] text-ink-tertiary">
                      {sc.baseline_commit_sha.slice(0, 8)}
                    </span>
                  </div>
                  <p className="mt-2 text-[14px] font-semibold text-ink">{sc.reason}</p>
                  <p className="mt-1 text-[12px] text-ink-secondary">
                    建议动作：{sc.suggested_action}
                  </p>
                </article>
              ))}

              {/* 3. Live OpenMausBot Pending Approvals / Secrets / Waiting-on-you */}
              {localAsks.map((ask: LocalBotAskItem) => (
                <article
                  key={ask.id}
                  className="rounded-2xl border border-hairline/80 bg-card p-4 shadow-sm transition hover:border-accent/40"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <BotAvatar
                        bot={{
                          name: ask.bot.name,
                          color: ask.bot.color,
                          avatarUrl: ask.bot.avatarUrl,
                          avatarCrop: ask.bot.avatarCrop,
                          avatarZoom: ask.bot.avatarZoom,
                          avatarFocusX: ask.bot.avatarFocusX,
                          avatarFocusY: ask.bot.avatarFocusY,
                          mascotBody: ask.bot.mascotBody,
                          mascotFaceColor: ask.bot.mascotFaceColor,
                        }}
                        size={20}
                      />
                      <span className="text-[12.5px] font-semibold text-ink">{ask.bot.name}</span>
                      <span className="rounded-md bg-warning/10 px-2 py-0.5 text-[10.5px] font-medium text-warning">
                        {ask.kind === "approval"
                          ? "执行审批"
                          : ask.kind === "secret"
                            ? "凭证输入"
                            : ask.kind === "signin"
                              ? "登录验证"
                              : "等待答复"}
                      </span>
                    </div>
                    <span className="text-[11px] text-ink-tertiary">{ask.threadTitle}</span>
                  </div>

                  <h3 className="mt-2 text-[14px] font-semibold text-ink">{ask.headline}</h3>
                  <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-secondary">{ask.detail}</p>

                  <div className="mt-3 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={() => handleTakeoverBot(ask.bot, ask.threadId)}
                      className="flex items-center gap-1.5 rounded-xl bg-accent/10 px-3 py-1.5 text-[12px] font-semibold text-accent transition hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
                    >
                      <span>立即接管处理</span>
                      <ArrowRight size={13} />
                    </button>
                  </div>
                </article>
              ))}

              {/* Empty State (State 3: Bounded Empty with Clear CTA) */}
              {telemetry.status !== "loading" && totalActionCount === 0 && (
                <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-hairline bg-panel/60 px-6 py-12 text-center">
                  <CheckCircle2 size={28} className="text-success" />
                  <h3 className="mt-3 text-[15px] font-semibold text-ink">
                    当前无待拍板卡点
                  </h3>
                  <p className="mt-1 max-w-md text-[12.5px] text-ink-secondary">
                    所有自动化流水线与专家会话均处于静默自治状态。你可以查看三域项目全景，或返回对话向 MausBot 下发新任务。
                  </p>
                  <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveTab("matrix")}
                      className="rounded-xl border border-hairline bg-card px-3.5 py-1.5 text-[12px] font-medium text-ink hover:bg-raised"
                    >
                      查看三域工厂大盘
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenChat?.()}
                      className="rounded-xl bg-accent px-3.5 py-1.5 text-[12px] font-medium text-[var(--color-accent-ink)] hover:brightness-110"
                    >
                      返回当前对话
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* TAB 2: Three-Domain Factory Matrix + Pipeline + AER + CLI Telemetry */
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
              {/* Domain Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {(
                    [
                      { id: "all", label: "全部域" },
                      { id: "app", label: "App 商业应用" },
                      { id: "fulfill", label: "Fulfill 履约风控" },
                      { id: "infra", label: "Infra 基座工程" },
                    ] as const
                  ).map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDomainFilter(d.id)}
                      className={cn(
                        "rounded-full border px-3 py-1 text-[11.5px] font-medium transition",
                        domainFilter === d.id
                          ? "border-accent/50 bg-accent/10 text-accent"
                          : "border-hairline bg-card text-ink-secondary hover:text-ink",
                      )}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] text-ink-tertiary">
                  只读映射自 Autofabric 控制面 · 不缓存平行状态
                </span>
              </div>

              {/* 7-Role Agent Pipeline */}
              <div className="rounded-2xl border border-hairline/80 bg-card p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[12.5px] font-semibold text-ink">
                    <Activity size={14} className="text-accent" />
                    <span>7 角色自治流水线 (Autofabric Pipeline)</span>
                  </div>
                  <span className="text-[11px] text-ink-tertiary">
                    {telemetry.overview?.agent_pipeline
                      ? `${telemetry.overview.agent_pipeline.length} 阶段在线`
                      : "等待控制面遥测"}
                  </span>
                </div>

                {telemetry.overview?.agent_pipeline ? (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
                    {telemetry.overview.agent_pipeline.map((step) => (
                      <div
                        key={step.step}
                        title={step.description}
                        className={cn(
                          "rounded-xl border p-2.5 text-left",
                          step.is_active
                            ? "border-accent/45 bg-accent/10"
                            : "border-hairline/60 bg-panel",
                        )}
                      >
                        <div className="flex items-center justify-between text-[10px] text-ink-tertiary">
                          <span>S{step.step}</span>
                          <span className={step.is_active ? "font-semibold text-accent" : ""}>
                            {step.status}
                          </span>
                        </div>
                        <div className="mt-1 truncate text-[11.5px] font-semibold text-ink">
                          {step.role_name}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-hairline bg-panel p-4 text-center text-[12px] text-ink-tertiary">
                    未检测到 Autofabric 后端连接，流水线状态保持 UNKNOWN（禁止显示假绿进度）。
                  </div>
                )}
              </div>

              {/* Portfolio Matrix + AER Scoreboard + CLI Telemetry */}
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="rounded-2xl border border-hairline/80 bg-card p-4 lg:col-span-2">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-[12.5px] font-semibold text-ink">
                      三域项目矩阵 (Portfolio Matrix)
                    </span>
                    <span className="text-[11px] text-ink-tertiary">
                      {filteredPortfolio.length} 个托管仓
                    </span>
                  </div>

                  {filteredPortfolio.length > 0 ? (
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {filteredPortfolio.map((repo) => (
                        <div
                          key={repo.repo_full_name}
                          className="rounded-xl border border-hairline/70 bg-panel p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-[12.5px] font-semibold text-ink">
                              {repo.display_name || repo.repo_full_name}
                            </span>
                            <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                              {repo.risk_tier}
                            </span>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between text-[11px] text-ink-secondary">
                            <span>状态：{repo.status}</span>
                            <span>WIP: {repo.active_wip}</span>
                          </div>
                          {repo.dag_links && (
                            <div className="mt-1 truncate font-mono text-[10px] text-ink-tertiary">
                              DAG: {repo.dag_links}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-xl border border-dashed border-hairline bg-panel p-6 text-center text-[12px] text-ink-tertiary">
                      当前域暂无托管仓库遥测数据。
                    </div>
                  )}
                </div>

                {/* AER + Multi-CLI Truthful Scoreboard */}
                <div className="flex flex-col gap-4">
                  <div className="rounded-2xl border border-hairline/80 bg-card p-4">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                        <ShieldCheck size={14} className="text-accent" />
                        AER 独立验签台账
                      </span>
                      <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
                        {telemetry.overview?.aer_scoreboard.measurement_status ?? "UNKNOWN"}
                      </span>
                    </div>
                    <p className="mt-2 text-[11.5px] text-ink-secondary">
                      {telemetry.overview?.aer_scoreboard.certification_badge ??
                        "UNVERIFIED (NO ACTIVE CONNECTION)"}
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px]">
                      <div className="rounded-lg bg-panel p-2">
                        <div className="text-ink-tertiary">FAIL→PASS</div>
                        <div className="font-semibold text-ink">
                          {telemetry.overview?.aer_scoreboard.fail_to_pass_count ?? "UNKNOWN"}
                        </div>
                      </div>
                      <div className="rounded-lg bg-panel p-2">
                        <div className="text-ink-tertiary">误放行率</div>
                        <div className="font-semibold text-ink">
                          {telemetry.overview?.aer_scoreboard.false_accept_rate_pct !== null &&
                          telemetry.overview?.aer_scoreboard.false_accept_rate_pct !== undefined
                            ? `${telemetry.overview.aer_scoreboard.false_accept_rate_pct}%`
                            : "UNKNOWN"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-2xl border border-hairline/80 bg-card p-4">
                    <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                      <Wrench size={14} className="text-accent" />
                      Multi-CLI 执行器遥测
                    </div>
                    {telemetry.overview?.cli_telemetry?.length ? (
                      <div className="space-y-1.5">
                        {telemetry.overview.cli_telemetry.map((cli) => (
                          <div
                            key={cli.name}
                            className="flex items-center justify-between rounded-lg bg-panel px-2.5 py-1.5 text-[11.5px]"
                          >
                            <div className="flex items-center gap-1.5">
                              <Cpu size={12} className="text-ink-tertiary" />
                              <span className="font-medium text-ink">{cli.name}</span>
                            </div>
                            <span className="font-mono text-[10.5px] text-ink-secondary">
                              {cli.win_rate_pct !== null
                                ? `${cli.win_rate_pct}%`
                                : cli.measurement_status}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-tertiary">
                        <ShieldAlert size={13} />
                        <span>无实时 CLI 遥测（显示 UNKNOWN）</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
