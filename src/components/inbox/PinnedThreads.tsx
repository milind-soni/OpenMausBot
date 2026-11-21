// The conversations each bot and room has pinned, gathered at the top of the Inbox so the person reaches them
// without leaving it: the last-activity label and open-row mark the finished list uses, plus an unpin button that
// dispatches the official action. Nothing here is stored; `task.pinned` is upstream's own field.
import { Pin, PinOff } from "lucide-react";
import type { Bot, Group } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  attentionOwnerName, attentionRowStatus, crossBotPinnedThreads, isOpenThread, openThreadRow,
  type AttentionThread, type OpenThread,
} from "../SidebarBotActivity";
import { formatUpdatedAt, threadRecency, threadUpdatedLabel } from "../SidebarThreadRow";

/** Pinned conversations from every bot and room, most recently active first, so the label beside a row and the
 * order rows sit in agree. Upstream's cross-bot list orders by sidebar position instead. */
export function pinnedThreadRows(bots: readonly Bot[], groups: readonly Group[], queued: Record<string, unknown[]>): AttentionThread[] {
  return crossBotPinnedThreads([...bots], [...groups], queued)
    .sort((a, b) => threadRecency(b.task) - threadRecency(a.task));
}

export function PinnedThreads({ rows, now, current, onOpen, onUnpin }: {
  rows: readonly AttentionThread[];
  /** The clock each row's last-activity label is relative to. */
  now: number;
  /** The conversation the chat window has open, marked like a selected sidebar row. */
  current?: OpenThread;
  onOpen(row: AttentionThread): void;
  onUnpin(row: AttentionThread): void;
}) {
  if (!rows.length) return null;
  return (
    <section data-inbox-pinned aria-label={t("sidebar.pinnedThreads.title")} className="border-b border-hairline/40 px-1.5 py-1.5">
      <div className="flex items-center gap-1.5 px-2 py-0.5">
        <Pin size={12} aria-hidden="true" className="shrink-0 text-ink-secondary" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink-secondary">{t("sidebar.pinnedThreads.title")}</span>
      </div>
      {rows.map((row) => {
        const name = attentionOwnerName(row);
        const { Icon, colorClass, label: status, active } = attentionRowStatus(row.task);
        const at = threadRecency(row.task);
        const when = threadUpdatedLabel(at, now);
        const meta = active ? `${name} · ${status}` : name;
        const label = t("sidebar.pinnedThreads.item", { title: row.task.title, name: when ? `${meta} · ${when}` : meta });
        const open = isOpenThread(row, current);
        return (
          <div key={`${row.kind}-${row.kind === "bot" ? row.botId : row.groupId}-${row.task.threadId}`} className="group/pinned flex w-full items-center">
            <button type="button" aria-label={label} title={label} data-pinned-row
              aria-current={open ? "page" : undefined} data-open-thread={open || undefined}
              onClick={() => onOpen(row)}
              className={cn("flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-menu-hover", open && openThreadRow)}>
              {active
                ? <Icon size={16} aria-hidden="true" className={cn("shrink-0", colorClass)} />
                : <Pin size={16} aria-hidden="true" className="shrink-0 text-ink-tertiary" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate" data-pinned-title>{row.task.title}</span>
                <span className="block truncate text-[11px] text-ink-secondary">
                  {meta}{when && <> · <time data-pinned-when dateTime={new Date(at).toISOString()} title={formatUpdatedAt(at)}>{when}</time></>}
                </span>
              </span>
            </button>
            <button type="button" data-inbox-unpin aria-label={t("sidebar.bot.unpin")} title={t("sidebar.bot.unpin")}
              onClick={() => onUnpin(row)}
              className="mr-1 flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover/pinned:opacity-100 max-md:opacity-70 touch:opacity-70">
              <PinOff size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </section>
  );
}
