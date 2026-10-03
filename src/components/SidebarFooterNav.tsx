// The places at the foot of the sidebar, as direct rows: Routines (the
// Automations page), Triggers and Apps (the two glass pop-ups). They used to
// hide behind a hover "Tools" menu; three rows cost little and each is one
// click instead of a hover and a click. Team map is an Advanced-mode place:
// a fourth row there, no menu.
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Network,
  Puzzle,
  Wrench,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { isRoutineProblemRun } from "@/lib/routines";
import { useSidebarToolsLayout, type SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

function NavRow({
  id,
  label,
  icon,
  active = false,
  attention = false,
  iconsOnly,
  tourId,
  onClick,
}: {
  id: string;
  label: string;
  icon: (active: boolean) => ReactNode;
  active?: boolean;
  attention?: boolean;
  iconsOnly: boolean;
  tourId?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-tour={tourId}
      data-sidebar-nav={id}
      onClick={onClick}
      aria-label={iconsOnly ? label : undefined}
      title={iconsOnly ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex w-full items-center rounded-xl text-left transition-colors",
        iconsOnly
          ? "min-h-10 justify-center px-2 py-2"
          : "min-h-9 gap-3 px-3 py-1.5",
        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon(active)}
      {!iconsOnly && (
        <span className="flex-1 truncate text-[14px]">{label}</span>
      )}
      {attention && (
        <span
          data-testid="routines-attention"
          className={cn(
            "size-2 shrink-0 rounded-full bg-danger",
            iconsOnly && "absolute right-2 top-2",
          )}
        />
      )}
    </button>
  );
}

export function SidebarFooterNav({
  density,
  collapsed = false,
  onToggle,
}: {
  density: SidebarDensity;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const toolsLayout = useSidebarToolsLayout();
  const iconsOnly = density === "icons";
  const compact = density === "compact";
  // The toolbar is the same NavRows' icon-only rendering laid out in a line;
  // icons density already renders that way, so it never changes.
  const toolbar = !iconsOnly && toolsLayout === "toolbar";
  const iconSize = iconsOnly ? 20 : 18;
  const tone = (active: boolean) =>
    active ? "text-accent" : "text-ink-secondary";
  const routinesNeedYou = state.routineRuns.some(
    (run) => isRoutineProblemRun(run) && !run.seenAt,
  );
  // Icons density is already minimal; the collapse control only earns its
  // keep once the rows carry labels worth folding away.
  const showToggle = !iconsOnly;
  const rowsExpanded = iconsOnly || !collapsed;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <>
      {showToggle && (
        <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-secondary">
          <button
            type="button"
            data-testid="sidebar-footer-tools-toggle"
            onClick={onToggle}
            disabled={!onToggle}
            aria-expanded={rowsExpanded}
            aria-label={t(
              collapsed ? "sidebar.section.expand" : "sidebar.section.collapse",
              { name: t("sidebar.tools") },
            )}
            className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Chevron size={compact ? 11 : 12} aria-hidden="true" />
          </button>
          <Wrench size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">{t("sidebar.tools")}</span>
        </div>
      )}
      {rowsExpanded && (
        // `tools` is the guided tour's anchor for "the places down here".
        <nav
          data-tour="tools"
          aria-label={t("sidebar.tools")}
          className={toolbar ? "flex flex-row gap-1" : "flex flex-col gap-0.5"}
        >
          <NavRow
            id="routines"
            label={t("sidebar.nav.routines")}
            tourId="nav-automations"
            iconsOnly={iconsOnly || toolbar}
            active={state.activeView === "routines"}
            attention={routinesNeedYou}
            icon={(active) => (
              <CalendarDays size={iconSize} className={tone(active)} />
            )}
            onClick={() => dispatch({ type: "showRoutines" })}
          />
          <NavRow
            id="triggers"
            label={t("sidebar.nav.triggers")}
            iconsOnly={iconsOnly || toolbar}
            active={state.triggersOpen}
            icon={(active) => <Zap size={iconSize} className={tone(active)} />}
            onClick={() => dispatch({ type: "toggleTriggers", open: true })}
          />
          <NavRow
            id="apps"
            label={t("sidebar.nav.apps")}
            tourId="nav-apps"
            iconsOnly={iconsOnly || toolbar}
            active={state.pluginsOpen}
            icon={(active) => (
              <Puzzle size={iconSize} className={tone(active)} />
            )}
            onClick={() => dispatch({ type: "togglePlugins", open: true })}
          />
          {advanced && (
            <NavRow
              id="team-map"
              label={t("sidebar.nav.teamMap")}
              tourId="team-tools"
              iconsOnly={iconsOnly || toolbar}
              active={state.activeView === "team-map"}
              icon={(active) => (
                <Network size={iconSize} className={tone(active)} />
              )}
              onClick={() => dispatch({ type: "showTeamMap" })}
            />
          )}
        </nav>
      )}
    </>
  );
}
