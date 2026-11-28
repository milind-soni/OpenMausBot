import { ChevronDown, ChevronRight } from "lucide-react";
import { useRef } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

import { AccountMoveStatus, useAccountMoveLine } from "./AccountMove";
import { CloudRoomCard } from "./CloudRoomCard";
import { CloudUsageCard } from "./CloudUsageMeter";
import { endCloudHowTo, useWorkspacePlace, type WorkspacePlace } from "./DesktopWorkspaceSwitcher";
import { SidebarConnectApps } from "./SidebarConnectApps";
import { SidebarBottomButtons, SidebarFooterNav, useAutomationsNeedYou } from "./SidebarFooterNav";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { StorageNotice } from "./StorageNotice";
import { SidebarProfileMenu, useSimpleAccount, type ArchivedBots } from "./SidebarProfileMenu";
import { UpdateIndicator } from "./UpdateIndicator";

export function useSimplePlace(): WorkspacePlace {
  const { state, dispatch } = useStore();
  return useWorkspacePlace({ cloudHome: state.config?.cloudHome === true, howTo: state.cloudHowTo, onMenuClosed: () => endCloudHowTo(dispatch) });
}

export function SidebarPlaceStatus({ place, className }: { place: WorkspacePlace; className?: string }) {
  if (place.error) return <p role="alert" className={cn("text-[12px] text-danger", className)}>{place.error}</p>;
  if (place.waking) return <p role="status" data-cloud-waking className={cn("text-[12px] text-ink-secondary", className)}>{place.waking}</p>;
  return null;
}

function SimpleSidebarFooter({ owner, archived }: { owner: string | null; archived?: ArchivedBots }) {
  const { state } = useStore();
  const place = useSimplePlace();
  const account = useSimpleAccount(place, owner, archived);
  const move = useAccountMoveLine(state.config?.cloudHome === true);
  const footer = useRef<HTMLDivElement>(null);
  // The move's words open the account menu just below them, where the move's row is.
  const openAccount = () => footer.current?.querySelector("[data-sidebar-account]")?.closest("button")?.click();
  return (
    <div ref={footer} data-sidebar-footer="simple" className="px-4 pb-4 pt-2">
      <CloudRoomCard />
      <CloudUsageCard />
      <SidebarPlaceStatus place={place} className="mb-2 px-1" />
      <StorageNotice className="mb-2 px-1" />
      <AccountMoveStatus kind={move.kind} place={move.place} retry={move.retry} onOpen={openAccount} className="ps-1" />
      <div className="flex items-center gap-2 not-first:mt-2">
        <SidebarProfileMenu simple={account} />
        <SidebarConnectApps />
        <UpdateIndicator />
      </div>
    </div>
  );
}

function ToolsFoldButton({ collapsed, alert, onToggle }: { collapsed: boolean; alert: boolean; onToggle?: () => void }) {
  if (!onToggle) return null;
  const label = t(collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: t("sidebar.tools") });
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      data-sidebar-tools-fold=""
      data-tour={collapsed ? "tools" : undefined}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      onClick={onToggle}
      className="relative mx-auto flex size-[46px] shrink-0 items-center justify-center rounded-xl text-ink-secondary hover:bg-raised hover:text-ink"
    >
      <Chevron size={18} aria-hidden="true" />
      {alert && <span data-testid="section-alert" aria-hidden="true" className="absolute right-2 top-2 size-2 rounded-full bg-danger" />}
    </button>
  );
}

export function SidebarFooter({ density, simple = false, owner = null, archived, toolsCollapsed, onToggleTools }: {
  density: SidebarDensity;
  simple?: boolean;
  owner?: string | null;
  archived?: ArchivedBots;
  toolsCollapsed: boolean;
  onToggleTools?: () => void;
}) {
  const { dispatch } = useStore();
  const automationsNeedYou = useAutomationsNeedYou();
  if (simple) return <SimpleSidebarFooter owner={owner} archived={archived} />;
  const icons = density === "icons";
  const toolsOpen = !icons || !toolsCollapsed;
  return (
    <div className={cn("pb-3 pt-2", icons ? "flex flex-col items-center gap-1 px-2" : "px-3")}>
      {icons && <ToolsFoldButton collapsed={toolsCollapsed} alert={toolsCollapsed && automationsNeedYou} onToggle={onToggleTools} />}
      {toolsOpen && <SidebarFooterNav density={density} collapsed={toolsCollapsed} onToggleCollapsed={onToggleTools} />}
      {icons ? (
        <>
          {toolsOpen && <SidebarPhoneButton density={density} onOpen={() => dispatch(phoneSettingsAction())} />}
          <div className="flex flex-col items-center justify-center gap-1">
            {toolsOpen && <UpdateIndicator />}
            <SidebarProfileMenu iconOnly />
          </div>
        </>
      ) : (
        <>
          <CloudRoomCard />
          <CloudUsageCard />
          <StorageNotice className="px-2" />
          <div className="flex items-center gap-1 not-first:mt-3">
            <div className="min-w-0 flex-1">
              <SidebarProfileMenu />
            </div>
            <SidebarBottomButtons />
          </div>
        </>
      )}
    </div>
  );
}
