import { Pin } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { PinnedThreadRows, type AttentionThread } from "./SidebarBotActivity";

/** A cross-bot, cross-room list of every pinned thread, living between
 * search and the bots list — pinned bots already get this top-level view
 * (the built-in Pinned section); pinned threads did not. Renders nothing
 * when there is no pin, so it never costs space it isn't using. */
export function SidebarPinnedThreadsPanel({ entries, density, now, onJump }: {
  entries: AttentionThread[];
  density: SidebarDensity;
  now: number;
  onJump: (entry: AttentionThread) => void;
}) {
  if (entries.length === 0) return null;
  const compact = density === "compact";
  return (
    <section
      data-testid="sidebar-pinned-threads-panel"
      aria-label={t("sidebar.pinnedThreads.title")}
      className={cn("mx-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/30", compact ? "mb-1.5" : "mb-2")}
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-secondary">
        <Pin size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.pinnedThreads.title")}</span>
        <span className="text-[10.5px] font-normal tabular-nums">{entries.length}</span>
      </div>
      <div className="max-h-56 overflow-y-auto">
        <PinnedThreadRows entries={entries} now={now} onJump={onJump} />
      </div>
    </section>
  );
}
