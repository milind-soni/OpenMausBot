// The popover shared by the sidebar's profile row and the chat header's More
// button: a trigger that opens a list of items. Only the trigger's shape, the
// side the menu opens on and the open gesture differ, so the keyboard
// handling, the outside-click close and the item chrome live here once.
//
// More opens on hover. The profile menu opens on click only, because a menu
// that appears under the cursor when you are aiming at nothing in particular
// is startling on a row you pass over constantly.
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";

export interface SidebarMenuItem {
  key: string;
  label: string;
  /** a second, quieter line under the label (where "Connect your phone" connects to) */
  subtitle?: string;
  /** a third, quieter line still: a short note (why something is not offered yet) */
  note?: string;
  icon?: React.ReactNode;
  active?: boolean;
  /** the item wants attention (an update ready to install, or one that
   * failed); drawn as a dot on the item */
  attention?: boolean;
  /** what the attention means — something went wrong (default) or something
   * good is waiting */
  attentionTone?: "danger" | "accent";
  disabled?: boolean;
  /** draw a hairline above this item — the Grok-style trailing group */
  separatorBefore?: boolean;
  /** a small caps label above this item, naming the group it starts (the
   * chat menu's "Share" over the two export actions) */
  heading?: string;
  /** rendered at the trailing edge (a spinner, a status dot) */
  trailing?: React.ReactNode;
  /** the menu normally closes on select; an item that reports progress in
   * place (the update check) keeps it open */
  keepOpen?: boolean;
  onSelect: () => void;
  /** `data-tour` id, so the guided tour can point at this item */
  tourId?: string;
}

/** Opening is quick enough to feel like a hover, closing is slow enough to
 * forgive a diagonal path from the trigger to the menu. */
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;

export function SidebarPopoverMenu({
  items,
  ariaLabel,
  openOnHover = false,
  placement = "above",
  renderTrigger,
}: {
  /** "above" stretches over the trigger's width and opens upward (the
   * sidebar's profile menu); "below" hangs a fixed-width sheet under the
   * trigger's right edge (a header icon). */
  placement?: "above" | "below";
  items: SidebarMenuItem[];
  ariaLabel: string;
  openOnHover?: boolean;
  renderTrigger: (state: { open: boolean }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const motion = useMenuMotion(open);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  const hoverOpen = () => {
    if (!openOnHover || pinned) return;
    clearTimers();
    openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  };
  const hoverClose = () => {
    if (!openOnHover || pinned) return;
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimers();
    setPinned(false);
    setOpen(false);
  };

  usePopoverDismiss(open, rootRef, close);

  return (
    <div
      ref={rootRef}
      className="relative"
      onPointerEnter={hoverOpen}
      onPointerLeave={hoverClose}
      // a keyboard user tabbing in gets the same menu a pointer gets
      onFocus={() => openOnHover && setOpen(true)}
      onBlur={(event) => {
        if (pinned) return;
        if (!event.relatedTarget || !rootRef.current?.contains(event.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          clearTimers();
          if (open && (pinned || !openOnHover)) close();
          else {
            setPinned(true);
            setOpen(true);
          }
        }}
        className="w-full"
      >
        {renderTrigger({ open })}
      </button>

      {motion.shown && (
        <div
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          {...motion.exitProps}
          className={cn(
            "absolute z-40 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50",
            placement === "below" ? "top-full right-0 mt-1 w-72 max-w-[calc(100vw-2rem)]" : "bottom-full left-0 right-0 mb-1",
            motion.className,
          )}
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore && <div className="my-1.5 h-px bg-hairline/50" />}
              {item.heading && <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{item.heading}</div>}
              <button
                type="button"
                role="menuitem"
                data-tour={item.tourId}
                disabled={item.disabled}
                onClick={() => {
                  item.onSelect();
                  if (!item.keepOpen) close();
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] disabled:opacity-60",
                  item.active ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
                )}
              >
                {item.icon && (
                  <span
                    className={cn(
                      "flex size-5 shrink-0 items-center justify-center",
                      item.active ? "text-accent" : "text-ink-secondary",
                    )}
                  >
                    {item.icon}
                  </span>
                )}
                {item.subtitle || item.note ? (
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{item.label}</span>
                    {item.subtitle && <span className="truncate text-[12px] text-ink-secondary">{item.subtitle}</span>}
                    {item.note && <span className="text-[11.5px] leading-snug text-ink-tertiary">{item.note}</span>}
                  </span>
                ) : (
                  <span className="flex-1 truncate">{item.label}</span>
                )}
                {item.trailing}
                {item.attention && (
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      item.attentionTone === "accent" ? "bg-accent" : "bg-danger",
                    )}
                  />
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
