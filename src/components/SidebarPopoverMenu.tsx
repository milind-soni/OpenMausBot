// The popover shared by the two rows at the foot of the sidebar: the Tools
// row and the profile row. Both are a trigger that opens a list of items
// above itself; only the trigger's shape and the open gesture differ, so the
// keyboard handling, the outside-click close and the item chrome live here
// once.
//
// Tools opens on hover (it is a browsing gesture — you sweep the bottom of
// the sidebar looking for the page you want). The profile menu opens on click
// only, because a menu that appears under the cursor when you are aiming at
// nothing in particular is startling on a row you pass over constantly.
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/cn";

export interface SidebarMenuItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  active?: boolean;
  /** the item wants attention (a failed routine, a downloaded update); a
   * folded item cannot show its own dot, so the trigger carries one on its
   * behalf */
  attention?: boolean;
  /** what the attention means — something went wrong (default) or something
   * good is waiting */
  attentionTone?: "danger" | "accent";
  disabled?: boolean;
  /** draw a hairline above this item — the Grok-style trailing group */
  separatorBefore?: boolean;
  /** rendered at the trailing edge (a spinner, a status dot) */
  trailing?: React.ReactNode;
  /** the menu normally closes on select; an item that reports progress in
   * place (the update check) keeps it open */
  keepOpen?: boolean;
  onSelect: () => void;
}

/** Opening is quick enough to feel like a hover, closing is slow enough to
 * forgive a diagonal path from the trigger to the menu. */
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;

export function SidebarPopoverMenu({
  items,
  ariaLabel,
  openOnHover = false,
  renderTrigger,
}: {
  items: SidebarMenuItem[];
  ariaLabel: string;
  openOnHover?: boolean;
  renderTrigger: (state: {
    open: boolean;
    attention: boolean;
    /** the loudest tone among the items asking for attention */
    attentionTone: "danger" | "accent";
  }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();

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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    const onDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  const asking = items.filter((item) => item.attention);
  const attention = asking.length > 0;
  // a failure outranks good news when both are folded away
  const attentionTone = asking.some((item) => item.attentionTone !== "accent") ? "danger" : "accent";

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
        {renderTrigger({ open, attention, attentionTone })}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={ariaLabel}
          className="animate-pop-in absolute bottom-full left-0 right-0 z-40 mb-1 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50"
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore && <div className="my-1.5 h-px bg-hairline/50" />}
              <button
                type="button"
                role="menuitem"
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
                <span className="flex-1 truncate">{item.label}</span>
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
