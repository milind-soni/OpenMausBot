// The popover shared by the sidebar's profile row and the chat header's More
// button: a trigger that opens a list of items. Only the trigger's shape, the
// side the menu opens on and the open gesture differ, so the keyboard
// handling, the outside-click close and the item chrome live here once.
//
// More opens on hover. The profile menu opens on click only, because a menu
// that appears under the cursor when you are aiming at nothing in particular
// is startling on a row you pass over constantly.
//
// The profile menu ("above") is one fixed-width sheet anchored to its
// trigger and kept inside the window, so it is the same menu whether the
// sidebar is wide, narrow or collapsed to avatars. It is drawn in a portal
// with fixed coordinates: the sidebar's own width and overflow do not reach
// it. An item can open a submenu beside it, and the keyboard moves through
// both (arrows, Home, End, Escape).
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
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
  /** a short value at the trailing edge, in the quieter ink */
  value?: string;
  /** the menu normally closes on select; an item that reports progress in
   * place (the update check) keeps it open */
  keepOpen?: boolean;
  /** the item opens these beside the menu instead of acting itself; it
   * draws a chevron and its onSelect is not called */
  submenu?: SidebarMenuItem[];
  onSelect: () => void;
  /** `data-tour` id, so the guided tour can point at this item */
  tourId?: string;
}

/** Opening is quick enough to feel like a hover, closing is slow enough to
 * forgive a diagonal path from the trigger to the menu. */
const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;
/** The anchored sheet's width, whatever the trigger's. */
export const ANCHORED_MENU_WIDTH = 280;
const EDGE_MARGIN = 8;
const ANCHOR_GAP = 6;

type Box = { left: number; right: number; top: number; bottom: number };
type Size = { width: number; height: number };

/** Where the anchored sheet goes: above the trigger, its start edge on the
 * trigger's start edge (the left in LTR, the right in RTL), below it when
 * there is no room above, and always inside the window. */
export function anchoredMenuPosition(anchor: Box, menu: Size, viewport: Size, rtl = false): { left: number; top: number } {
  const maxLeft = Math.max(EDGE_MARGIN, viewport.width - menu.width - EDGE_MARGIN);
  const left = Math.min(Math.max(rtl ? anchor.right - menu.width : anchor.left, EDGE_MARGIN), maxLeft);
  const above = anchor.top - ANCHOR_GAP - menu.height;
  const top = above >= EDGE_MARGIN ? above : anchor.bottom + ANCHOR_GAP;
  const maxTop = Math.max(EDGE_MARGIN, viewport.height - menu.height - EDGE_MARGIN);
  return { left, top: Math.min(Math.max(top, EDGE_MARGIN), maxTop) };
}

/** Where a submenu goes: beside its parent menu on the inline end side,
 * lined up with the row that opened it, flipped to the other side when the
 * window has no room, and always inside the window. */
export function submenuPosition(menu: Box, row: Box, submenu: Size, viewport: Size, rtl = false): { left: number; top: number } {
  const gap = 4;
  const after = rtl ? menu.left - gap - submenu.width : menu.right + gap;
  const before = rtl ? menu.right + gap : menu.left - gap - submenu.width;
  const fits = (left: number) => left >= EDGE_MARGIN && left + submenu.width <= viewport.width - EDGE_MARGIN;
  const preferred = fits(after) ? after : fits(before) ? before : after;
  const maxLeft = Math.max(EDGE_MARGIN, viewport.width - submenu.width - EDGE_MARGIN);
  const maxTop = Math.max(EDGE_MARGIN, viewport.height - submenu.height - EDGE_MARGIN);
  return {
    left: Math.min(Math.max(preferred, EDGE_MARGIN), maxLeft),
    top: Math.min(Math.max(row.top - 6, EDGE_MARGIN), maxTop),
  };
}

const isRtl = (element: Element | null) =>
  typeof getComputedStyle === "function" && element ? getComputedStyle(element).direction === "rtl" : false;

/** The enabled items of one menu, in order. */
const menuItems = (menu: HTMLElement | null) =>
  menu ? [...menu.querySelectorAll<HTMLElement>(':scope > div > [role="menuitem"]:not(:disabled)')] : [];

/** Arrow keys, Home and End move focus among a menu's items, wrapping. */
export function nextMenuIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown": return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp": return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home": return 0;
    case "End": return count - 1;
    default: return null;
  }
}

function MenuRows({
  items,
  roomy,
  openSubmenu,
  onItem,
  onSubmenuHover,
  onSubmenuLeave,
}: {
  items: SidebarMenuItem[];
  roomy: boolean;
  openSubmenu?: string | null;
  onItem: (item: SidebarMenuItem, element: HTMLElement) => void;
  onSubmenuHover?: (item: SidebarMenuItem, element: HTMLElement) => void;
  onSubmenuLeave?: () => void;
}) {
  return (
    <>
      {items.map((item) => (
        <div key={item.key}>
          {item.separatorBefore && <div role="separator" className={cn("h-px bg-hairline/50", roomy ? "mx-3 my-1.5" : "my-1.5")} />}
          {item.heading && <div className="px-3 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">{item.heading}</div>}
          <button
            type="button"
            role="menuitem"
            data-tour={item.tourId}
            data-menu-key={item.key}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? openSubmenu === item.key : undefined}
            onClick={(event) => onItem(item, event.currentTarget)}
            onPointerEnter={(event) => {
              if (item.submenu) onSubmenuHover?.(item, event.currentTarget);
              else onSubmenuLeave?.();
            }}
            className={cn(
              "flex w-full items-center text-start disabled:opacity-60 focus-visible:outline-none",
              roomy
                ? "min-h-10 gap-3 rounded-lg px-3 py-2 text-[15px] font-medium leading-5 focus-visible:bg-raised/70"
                : "gap-3 px-3.5 py-2 text-[14px] focus-visible:bg-raised/70",
              item.active || (item.submenu && openSubmenu === item.key) ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
            )}
          >
            {item.icon && (
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center",
                  item.active ? "text-accent" : roomy ? "text-ink" : "text-ink-secondary",
                )}
              >
                {item.icon}
              </span>
            )}
            {item.subtitle || item.note ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{item.label}</span>
                {item.subtitle && <span className="truncate text-[12px] font-normal leading-4 text-ink-secondary">{item.subtitle}</span>}
                {item.note && <span className="text-[11.5px] font-normal leading-snug text-ink-tertiary">{item.note}</span>}
              </span>
            ) : (
              <span className="flex-1 truncate">{item.label}</span>
            )}
            {item.value && <span className="shrink-0 text-[14px] font-normal leading-5 tabular-nums text-ink-secondary">{item.value}</span>}
            {item.trailing}
            {item.attention && (
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  item.attentionTone === "accent" ? "bg-accent" : "bg-danger",
                )}
              />
            )}
            {item.submenu && <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-secondary rtl:-scale-x-100" />}
          </button>
        </div>
      ))}
    </>
  );
}

export function SidebarPopoverMenu({
  items,
  ariaLabel,
  openOnHover = false,
  placement = "above",
  triggerClassName = "w-full",
  triggerTitle,
  renderTrigger,
}: {
  /** "above" is a fixed-width sheet anchored over the trigger's start edge,
   * opening upward and kept inside the window (the sidebar's profile menu);
   * "below" hangs a fixed-width sheet under the trigger's right edge (a
   * header icon). */
  placement?: "above" | "below";
  items: SidebarMenuItem[];
  ariaLabel: string;
  openOnHover?: boolean;
  /** the trigger button's own classes (an avatar-only trigger is not full width) */
  triggerClassName?: string;
  triggerTitle?: string;
  renderTrigger: (state: { open: boolean }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [subPosition, setSubPosition] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const subRowRef = useRef<HTMLElement | null>(null);
  const focusFirst = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const motion = useMenuMotion(open);
  const anchored = placement === "above";

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (subTimer.current) clearTimeout(subTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
    subTimer.current = null;
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
  const close = useCallback((refocus = false) => {
    clearTimers();
    setPinned(false);
    setOpen(false);
    setSubmenu(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // The anchored sheet lives in a portal, so "inside" is the trigger's root
  // or either sheet.
  const insideRef = useRef({
    contains: (target: unknown) =>
      [rootRef.current, menuRef.current, subRef.current].some((node) => node?.contains(target as Node)),
  });
  usePopoverDismiss(open, anchored ? insideRef : rootRef, () => close(anchored));

  // Place the sheet against the trigger, and again when the window moves under it.
  useLayoutEffect(() => {
    if (!anchored || !motion.shown) return;
    const place = () => {
      const trigger = triggerRef.current, menu = menuRef.current;
      if (!trigger || !menu) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      setPosition(anchoredMenuPosition(trigger.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.offsetHeight }, viewport, isRtl(trigger)));
      const sub = subRef.current, row = subRowRef.current;
      if (sub && row) {
        setSubPosition(submenuPosition(menu.getBoundingClientRect(), row.getBoundingClientRect(), { width: sub.offsetWidth, height: sub.offsetHeight }, viewport, isRtl(trigger)));
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchored, motion.shown, submenu, items.length]);

  // A keyboard open lands on the first item, once the anchored sheet is
  // placed (a hidden sheet cannot take focus).
  useEffect(() => {
    if (!open || !focusFirst.current || (anchored && !position)) return;
    focusFirst.current = false;
    menuItems(menuRef.current)[0]?.focus();
  }, [open, anchored, position]);

  const openSub = (item: SidebarMenuItem, row: HTMLElement, focus = false) => {
    if (subTimer.current) clearTimeout(subTimer.current);
    subRowRef.current = row;
    setSubPosition(null);
    setSubmenu(item.key);
    if (focus) requestAnimationFrame(() => menuItems(subRef.current)[0]?.focus());
  };
  const closeSub = (focusRow = false) => {
    if (subTimer.current) clearTimeout(subTimer.current);
    setSubmenu(null);
    if (focusRow) subRowRef.current?.focus();
  };

  const selectItem = (item: SidebarMenuItem, row: HTMLElement) => {
    if (item.submenu) {
      if (submenu === item.key) closeSub();
      else openSub(item, row, true);
      return;
    }
    item.onSelect();
    if (!item.keepOpen) close(anchored);
  };

  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>, inSubmenu: boolean) => {
    const menu = event.currentTarget;
    const list = menuItems(menu);
    const current = list.indexOf(document.activeElement as HTMLElement);
    const next = nextMenuIndex(event.key, current, list.length);
    if (next != null) {
      event.preventDefault();
      list[next]?.focus();
      return;
    }
    const rtl = isRtl(menu);
    const forward = rtl ? "ArrowLeft" : "ArrowRight";
    const back = rtl ? "ArrowRight" : "ArrowLeft";
    const focused = list[current];
    const item = focused ? items.find((entry) => entry.key === focused.dataset.menuKey) : undefined;
    if (!inSubmenu && event.key === forward && item?.submenu && focused) {
      event.preventDefault();
      openSub(item, focused, true);
    } else if (inSubmenu && (event.key === back || event.key === "Escape")) {
      // closes only the submenu; the window's Escape handler sees it handled
      event.preventDefault();
      event.stopPropagation();
      closeSub(true);
    } else if (event.key === "Tab" && anchored) {
      event.preventDefault();
      close(true);
    }
  };

  const openItem = submenu ? items.find((item) => item.key === submenu) : undefined;
  const roomy = anchored;
  const sheetClass = cn(
    "overflow-hidden border border-hairline/50 bg-menu shadow-2xl shadow-black/50",
    roomy ? "rounded-2xl p-1.5" : "rounded-xl py-1.5",
  );

  const sheet = motion.shown && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={ariaLabel}
      data-sidebar-popover-menu={anchored ? "anchored" : undefined}
      {...motion.exitProps}
      onKeyDown={(event) => onMenuKey(event, false)}
      onPointerLeave={() => {
        if (!openItem) return;
        if (subTimer.current) clearTimeout(subTimer.current);
        subTimer.current = setTimeout(() => setSubmenu((key) => (subRef.current?.matches(":hover") ? key : null)), CLOSE_DELAY_MS);
      }}
      style={anchored ? { position: "fixed", left: position?.left ?? 0, top: position?.top ?? 0, width: ANCHORED_MENU_WIDTH, maxWidth: `calc(100vw - ${EDGE_MARGIN * 2}px)`, visibility: position ? undefined : "hidden" } : undefined}
      className={cn(
        sheetClass,
        anchored ? "z-[60]" : "absolute z-40",
        placement === "below" && "top-full right-0 mt-1 w-72 max-w-[calc(100vw-2rem)]",
        motion.className,
      )}
    >
      <MenuRows
        items={items}
        roomy={roomy}
        openSubmenu={submenu}
        onItem={selectItem}
        onSubmenuHover={(item, row) => {
          if (subTimer.current) clearTimeout(subTimer.current);
          subTimer.current = setTimeout(() => openSub(item, row), OPEN_DELAY_MS);
        }}
        onSubmenuLeave={() => {
          if (!openItem) return;
          if (subTimer.current) clearTimeout(subTimer.current);
          subTimer.current = setTimeout(() => setSubmenu(null), OPEN_DELAY_MS);
        }}
      />
    </div>
  );

  const subSheet = motion.shown && openItem?.submenu && (
    <div
      ref={subRef}
      role="menu"
      aria-label={openItem.label}
      data-sidebar-popover-submenu
      onKeyDown={(event) => onMenuKey(event, true)}
      onPointerEnter={() => subTimer.current && clearTimeout(subTimer.current)}
      style={{ position: "fixed", left: subPosition?.left ?? 0, top: subPosition?.top ?? 0, minWidth: 220, width: "max-content", maxWidth: `min(${ANCHORED_MENU_WIDTH + 40}px, calc(100vw - ${EDGE_MARGIN * 2}px))`, visibility: subPosition ? undefined : "hidden" }}
      className={cn(sheetClass, "z-[61] animate-pop-in")}
    >
      <MenuRows
        items={openItem.submenu}
        roomy={roomy}
        onItem={(item) => {
          item.onSelect();
          if (!item.keepOpen) close(true);
        }}
      />
    </div>
  );

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
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={triggerTitle}
        onClick={(event) => {
          clearTimers();
          if (open && (pinned || !openOnHover)) close();
          else {
            // Enter and Space click with no pointer: land on the first item
            focusFirst.current = anchored && event.detail === 0;
            setPinned(true);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (!anchored || open || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
          event.preventDefault();
          focusFirst.current = true;
          setPinned(true);
          setOpen(true);
        }}
        className={triggerClassName}
      >
        {renderTrigger({ open })}
      </button>

      {anchored
        ? typeof document !== "undefined" && sheet ? createPortal(<>{sheet}{subSheet}</>, document.body) : null
        : sheet}
    </div>
  );
}
