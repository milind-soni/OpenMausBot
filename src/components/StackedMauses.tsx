import { Users } from "lucide-react";
import { cn } from "@/lib/cn";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { Bot } from "@/state/store";
import { BotAvatar } from "./Avatar";

const slotFor = (density: SidebarDensity, large: boolean) => density === "icons" ? "size-12" : large ? "size-9" : "size-8";

export function RoomMark({ density, large = false }: { density: SidebarDensity; large?: boolean }) {
  return (
    <div data-room-mark="" className={cn("flex shrink-0 items-center justify-center", slotFor(density, large))}>
      <Users aria-hidden="true" size={16} className="text-ink-secondary" />
    </div>
  );
}

export function StackedMauses({ members, density, large = false }: { members: Bot[]; density: SidebarDensity; large?: boolean }) {
  const iconOnly = density === "icons";
  const slotSize = slotFor(density, large);
  const singleSize = iconOnly ? 44 : large ? 36 : 32;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 2);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-2.5">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={iconOnly ? 30 : large ? 26 : 20} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-4 items-center justify-center rounded-full border border-hairline/40 bg-raised text-[9px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}
