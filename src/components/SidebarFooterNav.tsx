import { FolderOpen, Puzzle, Sun, UsersRound, Zap } from "lucide-react";
import type { ReactNode } from "react";

import { useAppTriggers } from "@/lib/app-triggers";
import { cn } from "@/lib/cn";
import { useCloudFilesReady } from "@/lib/cloud-files";
import { t } from "@/lib/i18n";
import { useAdvancedMode } from "@/lib/interface-mode";
import { isRoutineProblemRun } from "@/lib/routines";
import { useSidebarToolsLayout, type SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { UpdateIndicator } from "./UpdateIndicator";


function NavRow({
  id,
  label,
  icon,
  active = false,
  attention = false,
  iconsOnly,
  rail = false,
  tourId,
  onClick,
}: {
  id: string;
  label: string;
  icon: (active: boolean) => ReactNode;
  active?: boolean;
  attention?: boolean;
  iconsOnly: boolean;
  rail?: boolean;
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
        "relative flex items-center rounded-xl transition-colors",
        rail ? "size-9 shrink-0 justify-center" : iconsOnly ? "mx-auto size-[46px] shrink-0 justify-center" : "w-full min-h-9 gap-3 px-3 py-1.5 text-left",
        active ? "bg-raised text-ink" : "text-ink hover:bg-raised/50",
      )}
    >
      {icon(active)}
      {!iconsOnly && <span className="flex-1 truncate text-[14px] font-medium leading-5">{label}</span>}
      {attention && (
        <span
          data-testid="routines-attention"
          className={cn("size-2 shrink-0 rounded-full bg-danger", iconsOnly && (rail ? "absolute right-1 top-1" : "absolute right-2 top-2"))}
        />
      )}
    </button>
  );
}

/** Today and Apps, at the top of the sidebar in every mode, like an inbox and its address book. */
export function SidebarPagesNav({ density }: { density: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const iconsOnly = density === "icons";
  const iconSize = iconsOnly ? 20 : 18;
  const tone = (on: boolean) => (on ? "text-accent" : "text-ink-secondary");
  return (
    <div className={iconsOnly ? "flex flex-col items-center gap-1 px-2 pb-1" : "flex flex-col gap-0.5 px-2 pb-2"}>
      <NavRow
        id="today"
        label={t("sidebar.nav.today")}
        iconsOnly={iconsOnly}
        active={state.activeView === "today"}
        icon={(on) => <Sun size={iconSize} className={tone(on)} />}
        onClick={() => dispatch({ type: "showToday" })}
      />
      <NavRow
        id="apps"
        label={t("sidebar.nav.apps")}
        tourId="nav-apps"
        iconsOnly={iconsOnly}
        active={state.activeView === "apps"}
        icon={(on) => <Puzzle size={iconSize} className={tone(on)} />}
        onClick={() => dispatch({ type: "showApps" })}
      />
    </div>
  );
}

/** An unseen failed run, or an app trigger in trouble. */
function useAutomationsNeedYou(): boolean {
  const { state } = useStore();
  const appTriggers = useAppTriggers();
  return state.routineRuns.some((run) => isRoutineProblemRun(run) && !run.seenAt) || appTriggers.triggers.some((trigger) => trigger.enabled && trigger.problem);
}

/** The bar beside the profile. In Simple mode it carries Automations and Team map as icons, so the sidebar itself is only
 * Today and the chats; Advanced mode lists them as rows under Tools instead. Apps and the update button sit at the end. */
export function SidebarBottomButtons() {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const automationsNeedYou = useAutomationsNeedYou();
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");
  return (
    <div data-sidebar-bottom-buttons="" className="flex shrink-0 items-center gap-0.5">
      {!advanced && <>
        <NavRow
          id="automations"
          label={t("sidebar.nav.automations")}
          tourId="nav-automations"
          iconsOnly
          rail
          active={state.activeView === "routines"}
          attention={automationsNeedYou}
          icon={(active) => <Zap size={18} className={tone(active)} />}
          onClick={() => dispatch({ type: "showRoutines", view: "list" })}
        />
        <NavRow
          id="team-map"
          label={t("sidebar.nav.teamMap")}
          iconsOnly
          rail
          active={state.activeView === "team-map"}
          icon={(active) => <UsersRound size={18} className={tone(active)} />}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
      </>}
      <UpdateIndicator />
    </div>
  );
}

export function SidebarFooterNav({
  density,
  rail = false,
  collapsed = false,
  onToggleCollapsed,
}: {
  density: SidebarDensity;
  rail?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const { state, dispatch } = useStore();
  const advanced = useAdvancedMode();
  const iconsOnly = density === "icons";
  const toolsLayout = useSidebarToolsLayout();
  const toolbar = advanced && !iconsOnly && toolsLayout === "toolbar";
  const iconSize = iconsOnly && !rail ? 20 : 18;
  const tone = (active: boolean) => (active ? "text-accent" : "text-ink-secondary");
  const automationsNeedYou = useAutomationsNeedYou();
  const automationsRow = <NavRow
    id="automations"
    label={t("sidebar.nav.automations")}
    tourId="nav-automations"
    iconsOnly={iconsOnly || toolbar}
    rail={rail}
    active={state.activeView === "routines"}
    attention={automationsNeedYou}
    icon={(active) => <Zap size={iconSize} className={tone(active)} />}
    onClick={() => dispatch({ type: "showRoutines", view: "list" })}
  />;
  const filesRow = useCloudFilesReady() && <NavRow
    id="files"
    label={t("sidebar.nav.files")}
    iconsOnly={iconsOnly}
    rail={rail}
    active={state.activeView === "files"}
    icon={(active) => <FolderOpen size={iconSize} className={tone(active)} />}
    onClick={() => dispatch({ type: "showFiles" })}
  />;
  // Simple mode's Automations and Team map are icons in the bottom bar (SidebarBottomButtons); only Files stays a row.
  if (!advanced && !iconsOnly) return filesRow ? <nav aria-label={t("sidebar.tools")} className="flex flex-col gap-0.5">{filesRow}</nav> : null;

  const rows = (
    <>
      {automationsRow}
      {(advanced || iconsOnly) && (
        <NavRow
          id="team-map"
          label={t("sidebar.nav.teamMap")}
          tourId="team-tools"
          iconsOnly={iconsOnly || toolbar}
          rail={rail}
          active={state.activeView === "team-map"}
          icon={(active) => <UsersRound size={iconSize} className={tone(active)} />}
          onClick={() => dispatch({ type: "showTeamMap" })}
        />
      )}
      {filesRow}
    </>
  );

  if (iconsOnly) {
    return <nav data-tour="tools" aria-label={t("sidebar.tools")} className={cn("flex flex-col items-center", rail ? "gap-0.5" : "gap-1")}>{rows}</nav>;
  }
  return (
    <div data-tour="tools">
      <SidebarSectionHeader
        name={t("sidebar.tools")}
        collapsed={collapsed}
        alert={collapsed && automationsNeedYou}
        onToggle={onToggleCollapsed}
        reorderable={false}
        dragging={false}
      />
      {!collapsed && <nav aria-label={t("sidebar.tools")} className={toolbar ? "flex flex-row gap-1" : "flex flex-col gap-0.5"}>{rows}</nav>}
    </div>
  );
}
