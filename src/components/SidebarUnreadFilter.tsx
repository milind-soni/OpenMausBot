import { ListFilter, X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** The row under the pinned bots that opens the Unread filter, shaped like the Inbox row, with the bots it would list
 * as its count. It stays quiet with nothing to read. */
export function SidebarUnreadFilterRow({ count, open, large, onToggle }: { count: number; open: boolean; large: boolean; onToggle: () => void }) {
  const quiet = count === 0 && !open;
  const label = open ? t("sidebar.unreadFilter.close") : count > 0 ? t("sidebar.unreadFilter.count", { count }) : t("sidebar.unreadFilter.label");
  return (
    <div className="px-3 pb-1">
      <button type="button" data-sidebar-unread-filter={count} aria-pressed={open} aria-label={label} title={label} onClick={onToggle}
        className={cn("flex w-full min-w-0 items-center gap-2.5 rounded-xl px-2 py-1.5 text-start outline-none transition-colors duration-[120ms] hover:bg-ink/[0.06] focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none",
          open && "bg-raised hover:bg-raised-hover")}>
        <span className={cn("grid shrink-0 place-items-center rounded-full", open ? "bg-ink/[0.16] text-ink" : "bg-raised", quiet ? "text-ink-tertiary" : "text-ink-secondary", large ? "size-9" : "size-8")}>
          <ListFilter size={16} aria-hidden="true" />
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-[14px] font-medium leading-5", quiet ? "text-ink-tertiary" : "text-ink")}>{t("sidebar.unreadFilter.label")}</span>
        {open ? <X size={16} aria-hidden="true" className="shrink-0 text-ink-secondary" />
          : count > 0 && <span aria-hidden="true" data-unread-filter-count="" className="shrink-0 text-[12px] font-medium leading-4 tabular-nums text-ink-secondary">{count}</span>}
      </button>
    </div>
  );
}

/** What the sidebar lists while the Unread filter is open: its bots, or one line once everything is read. */
export function SidebarUnreadFilterList<T>({ bots, item }: { bots: readonly T[]; item: (bot: T) => ReactNode }) {
  if (bots.length === 0) return <div className="px-3 py-6 text-center text-[13px] leading-[18px] text-ink-secondary">{t("sidebar.unreadFilter.empty")}</div>;
  return <>{bots.map(item)}</>;
}
