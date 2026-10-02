// The places at the foot of the sidebar, as direct rows: Routines (the
// Automations page), Triggers and Apps (the two glass pop-ups). They used to
// hide behind a hover "Tools" menu; three rows cost little and each is one
// click instead of a hover and a click. Team map is an Advanced-mode place:
// a fourth row there, no menu.
import { CalendarDays, Network, Puzzle, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { isRoutineProblemRun } from "@/lib/routines";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
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
        iconsOnly ? "min-h-10 justify-center px-2 py-2" : "min-h-9 gap-3 px-3 py-1.5",
        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon(active)}
      {!iconsOnly && <span className="flex-1 truncate text-[14px]">{label}</span>}
      {attention && (
        <span
          data-testid="routines-attention"
          className={cn("size-2 shrink-0 rounded-full bg-danger", iconsOnly && "absolute right-2 top-2")}
        />
      )}
    </button>
  );
}

export function SidebarFooterNav({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const iconsOnly = density === "icons";
  const iconSize = iconsOnly ? 20 : 18;
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");
  const routinesNeedYou = state.routineRuns.some((run) => isRoutineProblemRun(run) && !run.seenAt);

  return (
    // `tools` is the guided tour's anchor for "the places down here".
    <nav data-tour="tools" aria-label={t("sidebar.tools")} className="flex flex-col gap-0.5">
      <NavRow
        id="routines"
        label={t("sidebar.nav.routines")}
        tourId="nav-automations"
        iconsOnly={iconsOnly}
        active={state.activeView === "routines"}
        attention={routinesNeedYou}
        icon={(active) => <CalendarDays size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "showRoutines" })}
      />
      <NavRow
        id="triggers"
        label={t("sidebar.nav.triggers")}
        iconsOnly={iconsOnly}
        active={state.triggersOpen}
        icon={(active) => <Zap size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "toggleTriggers", open: true })}
      />
      <NavRow
        id="apps"
        label={t("sidebar.nav.apps")}
        tourId="nav-apps"
        iconsOnly={iconsOnly}
        active={state.pluginsOpen}
        icon={(active) => <Puzzle size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "togglePlugins", open: true })}
      />
      {advanced && (
        <NavRow
          id="team-map"
          label={t("sidebar.nav.teamMap")}
          tourId="team-tools"
          iconsOnly={iconsOnly}
          active={state.activeView === "team-map"}
          icon={(active) => <Network size={iconSize} className={tone(active)} />}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
      )}
    </nav>
  );
}
