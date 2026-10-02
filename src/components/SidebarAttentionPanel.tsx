import { Activity, ChevronDown, ChevronRight, PinOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";

/** The pinned form of the attention panel: the same rows the popover lists,
 * living between search and the bots list so active work stays in view. */
export function SidebarAttentionPanel({ entries, density, onUnpin, onJump, collapsed, onToggle }: {
  entries: AttentionThread[];
  density: SidebarDensity;
  onUnpin: () => void;
  onJump: (entry: AttentionThread) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const compact = density === "compact";
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      data-testid="sidebar-attention-panel"
      aria-label={t("attention.title")}
      className={cn("mx-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/30", compact ? "mb-1.5" : "mb-2")}
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-secondary">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: t("attention.title") })}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Chevron size={compact ? 11 : 12} aria-hidden="true" />
        </button>
        <Activity size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("attention.title")}</span>
        {entries.length > 0 && (
          <span className="text-[10.5px] font-normal tabular-nums">{entries.length}</span>
        )}
        <button
          type="button"
          onClick={onUnpin}
          aria-label={t("attention.unpin")}
          title={t("attention.unpin")}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <PinOff size={compact ? 11 : 12} aria-hidden="true" />
        </button>
      </div>
      {!collapsed && (entries.length === 0 ? (
        <div className="px-2.5 pb-1.5 pt-0.5 text-[11px] text-ink-secondary">{t("attention.empty")}</div>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <AttentionThreadRows entries={entries} onJump={onJump} />
        </div>
      ))}
    </section>
  );
}
