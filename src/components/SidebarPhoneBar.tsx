import { SidebarInboxButton } from "./SidebarInboxButton";
import { FolderOpen, LayoutGrid, Puzzle, Rocket, Search, UsersRound, Zap } from "lucide-react";

import { useCloudFilesReady } from "@/lib/cloud-files";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";

import { CloudRoomCard } from "./CloudRoomCard";
import { CloudUsageCard } from "./CloudUsageMeter";
import { useAutomationsNeedYou } from "./use-automations-need-you";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { openCommandPalette } from "./CommandPalette";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { UpdateIndicator } from "./UpdateIndicator";

/** The phone's bottom bar: account, Inbox, tools, and search. */
export function SidebarPhoneBar({ onInboxOpened }: { onInboxOpened: () => void }) {
  const { state, dispatch } = useStore();
  const automationsNeedYou = useAutomationsNeedYou();
  const filesReady = useCloudFilesReady();
  const items: SidebarMenuItem[] = [
    {
      key: "automations",
      label: t("sidebar.nav.automations"),
      icon: <Zap size={18} />,
      active: state.activeView === "routines",
      attention: automationsNeedYou,
      onSelect: () => dispatch({ type: "showRoutines", view: "list" }),
    },
    {
      key: "team-map",
      label: t("sidebar.nav.teamMap"),
      icon: <UsersRound size={18} />,
      active: state.activeView === "team-map",
      onSelect: () => dispatch({ type: "showTeamMap" }),
    },
    ...(filesReady ? [{
      key: "files",
      label: t("sidebar.nav.files"),
      icon: <FolderOpen size={18} />,
      active: state.activeView === "files",
      onSelect: () => dispatch({ type: "showFiles" }),
    }] : []),
    {
      key: "published-apps",
      label: t("sidebar.nav.publishedApps"),
      icon: <Rocket size={18} />,
      active: state.activeView === "published-apps",
      onSelect: () => dispatch({ type: "showPublishedApps" }),
    },
    {
      key: "apps",
      label: t("sidebar.nav.apps"),
      icon: <Puzzle size={18} />,
      active: state.pluginsOpen,
      onSelect: () => dispatch({ type: "togglePlugins", open: true }),
    },
  ];
  return (
    <div data-sidebar-phone-bar className="px-3 pb-3 pt-1">
      <CloudRoomCard />
      <CloudUsageCard />
      <div className="flex items-center gap-2 not-first:mt-2">
        <SidebarProfileMenu iconOnly circle />
        <SidebarInboxButton className="size-11 border border-hairline bg-transparent ring-0" onOpened={onInboxOpened} />
        <SidebarPopoverMenu
          items={items}
          ariaLabel={t("sidebar.tools")}
          triggerClassName="flex shrink-0 rounded-full"
          triggerTitle={t("sidebar.tools")}
          renderTrigger={({ open }) => (
            <span className={`relative flex size-11 items-center justify-center rounded-full border border-hairline text-ink ${open ? "bg-raised" : "bg-transparent"}`}>
              <LayoutGrid size={19} aria-hidden="true" />
              {automationsNeedYou && <span aria-hidden className="absolute right-1 top-1 size-2.5 rounded-full bg-danger ring-2 ring-app" />}
            </span>
          )}
        />
        <button
          type="button"
          onClick={openCommandPalette}
          aria-haspopup="dialog"
          className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-transparent px-3.5 text-ink-secondary hover:bg-raised focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Search size={17} aria-hidden="true" />
          {t("sidebar.search")}
        </button>
        <UpdateIndicator />
      </div>
    </div>
  );
}
