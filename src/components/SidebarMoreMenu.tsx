// The sidebar's utility rows, folded behind one labelled row.
//
// Team map, Automations and Connected apps are places you visit
// occasionally; they were costing permanent rows at the bottom of a list
// whose whole job is showing bots. They now live behind a single "Tools"
// row that sits directly above the profile row and opens on hover.
//
// It used to be a bare chevron. A chevron alone reads as "there is more
// above" but never says more than that, so the row now carries an icon and a
// name like every other row in the sidebar, and the chevron shrinks to the
// state indicator it always was.
//
// Hover alone would make the items unreachable by keyboard and fragile with a
// trackpad, so: hovering opens it, a click pins it, Escape and an outside
// click close it, and the trigger is an ordinary focusable button.
import { ChevronUp, Wrench } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

export type MoreMenuItem = SidebarMenuItem;

export function SidebarMoreMenu({
  items,
  compact = false,
  // a default parameter is evaluated per call, so this follows the language
  // the same way every other t() in the rail does
  label = t("sidebar.tools"),
}: {
  items: MoreMenuItem[];
  compact?: boolean;
  label?: string;
}) {
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={label}
      openOnHover
      renderTrigger={({ open, attention }) => (
        <span
          className={cn(
            "flex min-h-9 w-full items-center gap-3 rounded-xl px-3 text-[14px] transition-colors",
            compact ? "py-1" : "py-1.5",
            open ? "bg-raised text-ink" : "bg-transparent text-ink hover:bg-raised/50",
          )}
        >
          <Wrench size={18} className={open ? "text-accent" : "text-ink-secondary"} />
          <span className="flex-1 truncate text-left">{label}</span>
          {attention && !open && <span className="size-2 shrink-0 rounded-full bg-danger" />}
          <ChevronUp
            size={14}
            className={cn("shrink-0 text-ink-secondary transition-transform", open && "rotate-180")}
          />
        </span>
      )}
    />
  );
}
