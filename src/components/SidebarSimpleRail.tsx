import { SidebarConnectApps } from "./SidebarConnectApps";
import { SidebarPlaceStatus, useSimplePlace } from "./SidebarFooter";
import { SidebarProfileMenu, useSimpleAccount, type ArchivedBots } from "./SidebarProfileMenu";
import { UpdateIndicator } from "./UpdateIndicator";

export function SidebarRailSeparator() {
  return <div aria-hidden="true" data-sidebar-rail-separator="" className="mx-auto my-1.5 h-px w-8 shrink-0 bg-hairline/70" />;
}

export function SimpleRailFooter({ owner = null, archived }: {
  owner?: string | null;
  archived?: ArchivedBots;
}) {
  const place = useSimplePlace();
  const account = useSimpleAccount(place, owner, archived);
  return (
    <div data-sidebar-rail-footer="" className="relative flex flex-col items-center gap-2 px-2 pb-4 pt-2">
      <SidebarConnectApps circle />
      <UpdateIndicator />
      <SidebarProfileMenu iconOnly rail simple={account} />
      <SidebarPlaceStatus place={place} className="absolute bottom-3 left-full z-40 ml-2 w-56 rounded-md bg-menu px-2 py-1 text-[11px] shadow-lg" />
    </div>
  );
}
