import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { isSidebarCollapseAll } from "@/lib/keyboard-shortcuts";
import { setSidebarCollapsedAll, useSidebarCollapsedAll } from "@/lib/search-disclosure";

/** The line under Inbox with the sidebar-wide actions. Each action is one icon button on the right. */
export function SidebarActionsRow({ collapsedAll, searching, onToggleCollapsedAll }: {
  collapsedAll: boolean;
  /** The search box has text, so what is open follows the results and collapse-all has nothing to act on. */
  searching: boolean;
  onToggleCollapsedAll: () => void;
}) {
  const label = t(collapsedAll ? "sidebar.expandAll" : "sidebar.collapseAll");
  const Icon = collapsedAll ? ChevronsUpDown : ChevronsDownUp;
  return (
    <div data-sidebar-actions="" className="flex h-[30px] shrink-0 items-center gap-1.5 pl-5 pr-4 pb-1 pt-2">
      <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-secondary">{t("sidebar.section.bots")}</span>
      <button
        type="button"
        onClick={onToggleCollapsedAll}
        disabled={searching}
        aria-label={label}
        title={label}
        aria-keyshortcuts="Control+Shift+Backslash Meta+Shift+Backslash"
        className="flex h-[18px] w-[22px] shrink-0 items-center justify-center rounded-[6px] text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-tertiary"
      >
        <Icon size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The row and its ⌘⇧\ shortcut: collapses or expands every bot's thread list and the given department sections. */
export function SidebarCollapseAllRow({ enabled, query, sectionIds, setAllCollapsed }: {
  enabled: boolean;
  query: string;
  sectionIds: string[];
  setAllCollapsed: (ids: string[], collapsed: boolean) => void;
}) {
  const collapsedAll = useSidebarCollapsedAll();
  const toggle = () => {
    if (!enabled || query) return;
    setSidebarCollapsedAll(!collapsedAll);
    setAllCollapsed(sectionIds, !collapsedAll);
  };
  const latest = useRef(toggle);
  latest.current = toggle;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (isSidebarCollapseAll(event)) { event.preventDefault(); latest.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return enabled ? <SidebarActionsRow collapsedAll={collapsedAll} searching={query !== ""} onToggleCollapsedAll={toggle} /> : null;
}
