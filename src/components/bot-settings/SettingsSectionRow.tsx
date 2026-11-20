import { useId, type ReactNode } from "react";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { BotSettingsSection } from "@/state/store";
import { useMenuMotion } from "../MenuMotion";
import { SIMPLE_ROW_FOCUS } from "../SidebarSimpleTop";

export function SettingsSectionRow({ id, icon: Icon, label, open, hidden, keepMounted, onToggle, children }: {
  id: BotSettingsSection;
  icon: LucideIcon;
  label: string;
  open: boolean;
  hidden: boolean;
  keepMounted: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  const motion = useMenuMotion(open);

  return (
    <div data-bot-settings-section={id} hidden={hidden}
      className={cn("mb-1 rounded-2xl motion-safe:transition-colors", motion.shown && "bg-card ring-1 ring-inset ring-hairline/50")}>
      <button type="button" aria-expanded={open} aria-controls={bodyId}
        onClick={onToggle}
        className={cn("group flex min-h-10 w-full items-center gap-2.5 rounded-xl px-2.5 py-1 text-left text-[13px] font-medium text-ink transition-colors", SIMPLE_ROW_FOCUS,
          open ? "bg-raised/50" : "interaction:bg-raised/50")}>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-control/70 text-ink-secondary group-hover:text-ink">
          <Icon size={15} strokeWidth={1.65} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight size={14} aria-hidden="true" className={cn("mr-0.5 shrink-0 text-ink-secondary motion-safe:transition-transform", open && "rotate-90")} />
      </button>
      <div id={bodyId} inert={!open} aria-hidden={!open || undefined}
        className={cn("grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-200 motion-safe:ease-in-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
        <div className="min-h-0 min-w-0 overflow-clip">
          {(motion.shown || keepMounted) && <div className="min-w-0 px-3 pb-3 pt-2.5">{children}</div>}
        </div>
      </div>
    </div>
  );
}
