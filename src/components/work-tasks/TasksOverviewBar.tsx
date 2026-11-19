import { AlertTriangle, CheckCircle2, Clock, Eye, Layers, PlayCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import type { AgentTaskStatus, RoomWorkTaskOverview } from "../../../shared/work-tasks";
import { BotAvatar } from "../Avatar";

export interface OverviewQuickFilter {
  status?: AgentTaskStatus | "";
  overdueOnly?: boolean;
  assigneeBotId?: string;
}

export function TasksOverviewBar({
  overview,
  members,
  activeFilter,
  onSelectFilter,
}: {
  overview: RoomWorkTaskOverview;
  members: Bot[];
  activeFilter: OverviewQuickFilter;
  onSelectFilter: (next: OverviewQuickFilter) => void;
}) {
  const memberById = new Map(members.map((m) => [m.id, m]));

  const statChips: Array<{
    key: string;
    label: string;
    count: number;
    icon: typeof Layers;
    active: boolean;
    tone?: "default" | "accent" | "warning" | "danger" | "success";
    onClick: () => void;
  }> = [
    {
      key: "total",
      label: t("workTasks.overview.total"),
      count: overview.total,
      icon: Layers,
      active: !activeFilter.status && !activeFilter.overdueOnly && !activeFilter.assigneeBotId,
      onClick: () => onSelectFilter({ status: "", overdueOnly: false, assigneeBotId: "" }),
    },
    {
      key: "in-progress",
      label: t("workTasks.overview.inProgress"),
      count: overview.inProgress,
      icon: PlayCircle,
      tone: "accent",
      active: activeFilter.status === "in-progress",
      onClick: () =>
        onSelectFilter({
          status: activeFilter.status === "in-progress" ? "" : "in-progress",
          overdueOnly: false,
        }),
    },
    {
      key: "blocked",
      label: t("workTasks.overview.blocked"),
      count: overview.blocked + overview.failed,
      icon: AlertTriangle,
      tone: "danger",
      active: activeFilter.status === "blocked",
      onClick: () =>
        onSelectFilter({
          status: activeFilter.status === "blocked" ? "" : "blocked",
          overdueOnly: false,
        }),
    },
    {
      key: "in-review",
      label: t("workTasks.overview.waitingQa"),
      count: overview.waitingQa,
      icon: Eye,
      tone: "warning",
      active: activeFilter.status === "in-review",
      onClick: () =>
        onSelectFilter({
          status: activeFilter.status === "in-review" ? "" : "in-review",
          overdueOnly: false,
        }),
    },
    {
      key: "done",
      label: t("workTasks.overview.done"),
      count: overview.done,
      icon: CheckCircle2,
      tone: "success",
      active: activeFilter.status === "done",
      onClick: () =>
        onSelectFilter({
          status: activeFilter.status === "done" ? "" : "done",
          overdueOnly: false,
        }),
    },
    {
      key: "overdue",
      label: t("workTasks.overview.overdue"),
      count: overview.overdue,
      icon: Clock,
      tone: overview.overdue > 0 ? "danger" : "default",
      active: Boolean(activeFilter.overdueOnly),
      onClick: () =>
        onSelectFilter({
          overdueOnly: !activeFilter.overdueOnly,
          status: "",
        }),
    },
  ];

  return (
    <div className="flex flex-col gap-2 border-b border-hairline bg-panel/60 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {statChips.map((chip) => {
          const Icon = chip.icon;
          const toneClass =
            chip.tone === "danger" && chip.count > 0
              ? "text-danger"
              : chip.tone === "warning" && chip.count > 0
                ? "text-warning"
                : chip.tone === "success" && chip.count > 0
                  ? "text-success"
                  : chip.tone === "accent" && chip.count > 0
                    ? "text-accent-text"
                    : "text-ink-secondary";
          return (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onClick}
              aria-pressed={chip.active}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition-colors",
                chip.active
                  ? "border-accent bg-accent/10 font-medium text-ink"
                  : "border-hairline bg-card text-ink-secondary hover:bg-ink/[0.04] hover:text-ink",
              )}
            >
              <Icon size={13} className={toneClass} aria-hidden="true" />
              <span>{chip.label}</span>
              <span className="font-mono text-[11px] font-semibold tabular-nums text-ink">{chip.count}</span>
            </button>
          );
        })}
      </div>

      {overview.byAgent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[11px] font-medium text-ink-tertiary">{t("workTasks.overview.agents")}:</span>
          {overview.byAgent.map((agent) => {
            const bot = memberById.get(agent.botId);
            const selected = activeFilter.assigneeBotId === agent.botId;
            return (
              <button
                key={agent.botId}
                type="button"
                onClick={() =>
                  onSelectFilter({
                    assigneeBotId: selected ? "" : agent.botId,
                  })
                }
                aria-pressed={selected}
                title={
                  agent.role
                    ? `${agent.name} (${agent.role}) — ${agent.total} tasks`
                    : `${agent.name} — ${agent.total} tasks`
                }
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                  selected
                    ? "border-accent bg-accent/10 text-ink"
                    : "border-hairline bg-card/80 text-ink-secondary hover:bg-ink/[0.04] hover:text-ink",
                )}
              >
                {bot && <BotAvatar bot={bot} state="happy" size={14} animated={false} />}
                <span className="font-medium text-ink">{agent.name}</span>
                {agent.role && <span className="text-ink-tertiary">· {agent.role}</span>}
                <span className="font-mono tabular-nums text-ink-secondary">{agent.total}</span>
                {agent.busy && (
                  <span
                    className="size-1.5 rounded-full bg-accent"
                    title={t("workTasks.agent.busy")}
                  />
                )}
                {agent.hasFailures && (
                  <span
                    className="size-1.5 rounded-full bg-danger"
                    title={t("workTasks.agent.hasFailures")}
                  />
                )}
                {!agent.busy && agent.hasNoTasks && (
                  <span className="text-[10px] text-ink-tertiary">({t("workTasks.agent.idle")})</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

