import type { ReactNode } from "react";
import { SidebarInboxButton } from "./SidebarInboxButton";
import { SidebarConnectApps } from "./SidebarConnectApps";
import { SidebarPlaceStatus, useSimplePlace } from "./SidebarFooter";
import { SidebarProfileMenu, useSimpleAccount, type ArchivedBots } from "./SidebarProfileMenu";
import { UpdateIndicator } from "./UpdateIndicator";

export function SidebarRailSeparator() {
  return <div aria-hidden="true" data-sidebar-rail-separator="" className="mx-auto my-1.5 h-px w-[54px] shrink-0 bg-ink/[0.08]" />;
}

export function SimpleRailFooter({ owner = null, archived, children }: {
  owner?: string | null;
  archived?: ArchivedBots;
  children: ReactNode;
}) {
  const place = useSimplePlace();
  const account = useSimpleAccount(place, owner, archived);
  return (
    <div data-sidebar-rail-footer="" className="relative flex flex-col items-center gap-2 px-2 pb-4 pt-2">
      {children}
      <SidebarConnectApps circle />
      <UpdateIndicator />
      <SidebarInboxButton rail />
      <SidebarProfileMenu rail simple={account} />
      <SidebarPlaceStatus place={place} className="absolute bottom-3 left-full z-40 ml-2 w-56 rounded-md bg-menu px-2 py-1 text-[11px] shadow-lg" />
    </div>
  );
}
