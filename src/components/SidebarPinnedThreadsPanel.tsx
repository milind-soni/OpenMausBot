import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { t } from "@/lib/i18n";
import { PinnedThreadRows, type AttentionThread } from "./SidebarBotActivity";
import { useRelativeNow } from "./SidebarThreadRow";

type PanelProps = {
  entries: AttentionThread[];
  now?: number;
  onJump: (entry: AttentionThread) => void;
  onUnpin: (entry: AttentionThread) => void;
  collapsed: boolean;
  onToggle?: () => void;
};

function PinnedThreadsBody({ entries, now, onJump, onUnpin, collapsed, onToggle }: PanelProps & { now: number }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      data-testid="sidebar-pinned-threads-panel"
      aria-label={t("sidebar.pinnedThreads.title")}
      className="mx-2 mb-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/30"
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[12px] font-medium text-ink-secondary">
        <button
          type="button"
          onClick={onToggle}
          disabled={!onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: t("sidebar.pinnedThreads.title") })}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Chevron size={12} aria-hidden="true" />
        </button>
        <Pin size={12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.pinnedThreads.title")}</span>
        <span className="text-[12px] font-normal tabular-nums">{entries.length}</span>
      </div>
      {!collapsed && (
        <div className="max-h-56 overflow-y-auto">
          <PinnedThreadRows entries={entries} now={now} onJump={onJump} onUnpin={onUnpin} />
        </div>
      )}
    </section>
  );
}

function LivePinnedThreadsPanel(props: Omit<PanelProps, "now">) {
  return <PinnedThreadsBody {...props} now={useRelativeNow()} />;
}

export function SidebarPinnedThreadsPanel({ now, ...props }: PanelProps) {
  if (props.entries.length === 0) return null;
  if (now !== undefined) return PinnedThreadsBody({ ...props, now });
  return <LivePinnedThreadsPanel {...props} />;
}
