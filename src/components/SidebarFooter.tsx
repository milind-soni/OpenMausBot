import { cn } from "@/lib/cn";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { useStore } from "@/state/store";

import { CloudUsageCard } from "./CloudUsageMeter";
import { SidebarBottomButtons, SidebarFooterNav } from "./SidebarFooterNav";
import { phoneSettingsAction, SidebarPhoneButton } from "./SidebarPhoneButton";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { UpdateIndicator } from "./UpdateIndicator";

export function SidebarFooter({ density, toolsCollapsed, onToggleTools }: { density: SidebarDensity; toolsCollapsed: boolean; onToggleTools?: () => void }) {
  const { dispatch } = useStore();
  return (
    <div className={cn("pb-3 pt-2", density === "icons" ? "flex flex-col items-center gap-1 px-2" : "px-3")}>
      <SidebarFooterNav density={density} collapsed={toolsCollapsed} onToggleCollapsed={onToggleTools} />
      {density === "icons" ? (
        <>
          <SidebarPhoneButton density={density} onOpen={() => dispatch(phoneSettingsAction())} />
          <div className="flex flex-col items-center justify-center gap-1">
            <UpdateIndicator />
            <SidebarProfileMenu iconOnly />
          </div>
        </>
      ) : (
        <>
          <CloudUsageCard />
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
