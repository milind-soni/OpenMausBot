// The places at the foot of the sidebar, as direct rows: Routines (the
// Automations page) and Triggers, then Team map in Advanced mode. They used
// to hide behind a hover "Tools" menu; a row each is one click instead of a
// hover and a click. Simple mode keeps none of them: scheduling and webhooks
// are builder tools. Apps sits beside the profile (SidebarAppsButton), except
// on the avatars-only rail, where it stays a row just above the avatar.
import { CalendarDays, Network, Puzzle, Zap } from "lucide-react";
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

/** Apps, as a round icon button at the end of the profile row. */
export function SidebarAppsButton() {
  const { state, dispatch } = useStore();
  const label = t("sidebar.nav.apps");
  return (
    <button
      type="button"
      data-tour="nav-apps"
      data-sidebar-nav="apps"
      onClick={() => dispatch({ type: "togglePlugins", open: true })}
      aria-label={label}
      title={label}
      aria-pressed={state.pluginsOpen}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors",
        state.pluginsOpen ? "bg-raised text-accent" : "text-ink-secondary hover:bg-raised/50 hover:text-ink",
      )}
    >
      <Puzzle size={18} />
    </button>
  );
}

export function SidebarFooterNav({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const toolsLayout = useSidebarToolsLayout();
  const iconsOnly = density === "icons";
  // The toolbar is the same NavRows rendered icon-only in a line; icons
  // density already renders that way, so its output never changes.
  const toolbar = !iconsOnly && toolsLayout === "toolbar";
  const iconSize = iconsOnly ? 20 : 18;
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");
  const routinesNeedYou = state.routineRuns.some((run) => isRoutineProblemRun(run) && !run.seenAt);
  // Simple mode on a full-width sidebar has no rows left: draw nothing, so
  // the profile row is the foot's first line.
  if (!advanced && !iconsOnly) return null;

  return (
    // `tools` is the guided tour's anchor for "the places down here".
    <nav
      data-tour="tools"
      aria-label={t("sidebar.tools")}
      className={toolbar ? "flex flex-row gap-1" : "flex flex-col gap-0.5"}
    >
      {advanced && <NavRow
        id="routines"
        label={t("sidebar.nav.routines")}
        tourId="nav-automations"
        iconsOnly={iconsOnly || toolbar}
        active={state.activeView === "routines"}
        attention={routinesNeedYou}
        icon={(active) => <CalendarDays size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "showRoutines" })}
      />}
      {advanced && <NavRow
        id="triggers"
        label={t("sidebar.nav.triggers")}
        iconsOnly={iconsOnly || toolbar}
        active={state.triggersOpen}
        icon={(active) => <Zap size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "toggleTriggers", open: true })}
      />}
      {iconsOnly && <NavRow
        id="apps"
        label={t("sidebar.nav.apps")}
        tourId="nav-apps"
        iconsOnly={iconsOnly || toolbar}
        active={state.pluginsOpen}
        icon={(active) => <Puzzle size={iconSize} className={tone(active)} />}
        onClick={() => dispatch({ type: "togglePlugins", open: true })}
      />}
      {advanced && (
        <NavRow
          id="team-map"
          label={t("sidebar.nav.teamMap")}
          tourId="team-tools"
          iconsOnly={iconsOnly || toolbar}
          active={state.activeView === "team-map"}
          icon={(active) => <Network size={iconSize} className={tone(active)} />}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
      )}
    </nav>
  );
}
