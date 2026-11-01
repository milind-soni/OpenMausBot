import { Activity, ChevronDown, ChevronRight, PinOff } from "lucide-react";
import { t } from "@/lib/i18n";
import { AttentionThreadRows, type AttentionThread } from "./SidebarBotActivity";

export function SidebarAttentionPanel({ entries, onUnpin, onJump, collapsed, onToggle }: {
  entries: AttentionThread[];
  onUnpin: () => void;
  onJump: (entry: AttentionThread) => void;
  collapsed: boolean;
  onToggle?: () => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      data-testid="sidebar-attention-panel"
      aria-label={t("attention.title")}
      className="mx-2 mb-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/30"
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-ink-secondary">
        <button
          type="button"
          onClick={onToggle}
          disabled={!onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: t("attention.title") })}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Chevron size={12} aria-hidden="true" />
        </button>
        <Activity size={12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("attention.title")}</span>
        {entries.length > 0 && (
          <span className="text-[11px] font-normal tabular-nums">{entries.length}</span>
        )}
        <button
          type="button"
          onClick={onUnpin}
          aria-label={t("attention.unpin")}
          title={t("attention.unpin")}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <PinOff size={12} aria-hidden="true" />
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
