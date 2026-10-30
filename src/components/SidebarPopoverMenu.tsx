import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { popoverClosesOnKey, usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { submenuIntent, type Point, type SubmenuIntent } from "@/lib/submenu-intent";
import { MENU_HEADING, MENU_ITEM_SEPARATOR, MENU_SHEET } from "./menu-recipe";

export interface SidebarMenuItem {
  key: string;
  label: string;
  subtitle?: string;
  note?: string;
  icon?: React.ReactNode;
  active?: boolean;
  attention?: boolean;
  attentionTone?: "danger" | "accent";
  disabled?: boolean;
  separatorBefore?: boolean;
  heading?: string;
  trailing?: React.ReactNode;
  value?: string;
  keepOpen?: boolean;
  submenu?: SidebarMenuItem[];
  chevron?: boolean;
  /** a sentence that wraps instead of being cut short */
  wrap?: boolean;
  /** the row's tooltip, for what its one line leaves out */
  title?: string;
  onSelect: () => void;
  tourId?: string;
}

const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 250;
export const MENU_MIN_WIDTH = 237;
const MENU_MAX_WIDTH = 320;
const EDGE_MARGIN = 8;
const ANCHOR_GAP = 6;

type Box = { left: number; right: number; top: number; bottom: number };
type Size = { width: number; height: number };

export function anchoredMenuPosition(anchor: Box, menu: Size, viewport: Size, rtl = false): { left: number; top: number } {
  const maxLeft = Math.max(EDGE_MARGIN, viewport.width - menu.width - EDGE_MARGIN);
  const left = Math.min(Math.max(rtl ? anchor.right - menu.width : anchor.left, EDGE_MARGIN), maxLeft);
  const above = anchor.top - ANCHOR_GAP - menu.height;
  const top = above >= EDGE_MARGIN ? above : anchor.bottom + ANCHOR_GAP;
  const maxTop = Math.max(EDGE_MARGIN, viewport.height - menu.height - EDGE_MARGIN);
  return { left, top: Math.min(Math.max(top, EDGE_MARGIN), maxTop) };
}

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

const menuItems = (menu: HTMLElement | null) =>
  menu ? [...menu.querySelectorAll<HTMLElement>(':scope > div > [role="menuitem"]:not(:disabled)')] : [];

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
  openSubmenu,
  engaged = false,
  onItem,
  onRowEnter,
  onRowLeave,
}: {
  items: SidebarMenuItem[];
  openSubmenu?: string | null;
  engaged?: boolean;
  onItem: (item: SidebarMenuItem, element: HTMLElement, keyboard: boolean) => void;
  onRowEnter?: (item: SidebarMenuItem, element: HTMLElement, point: Point) => void;
  onRowLeave?: (item: SidebarMenuItem) => void;
}) {
  return (
    <>
      {items.map((item) => (
        <div key={item.key} className="flex flex-col gap-1">
          {item.separatorBefore && <div role="separator" className={MENU_ITEM_SEPARATOR} />}
          {item.heading && <div className={MENU_HEADING}>{item.heading}</div>}
          <button
            type="button"
            role="menuitem"
            data-tour={item.tourId}
            data-menu-key={item.key}
            title={item.title}
            disabled={item.disabled}
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? openSubmenu === item.key : undefined}
            onClick={(event) => onItem(item, event.currentTarget, event.detail === 0)}
            onPointerEnter={(event) => onRowEnter?.(item, event.currentTarget, { x: event.clientX, y: event.clientY })}
            onPointerLeave={() => onRowLeave?.(item)}
            className={cn(
              "flex min-h-[30px] w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-[14px] leading-[18px] disabled:opacity-60 focus-visible:bg-menu-hover focus-visible:outline-none",
              item.active || (item.submenu && openSubmenu === item.key && engaged) ? "bg-menu-active text-ink" : "text-ink hover:bg-menu-hover",
            )}
          >
            {item.icon && (
              <span
                className={cn("flex size-4 shrink-0 items-center justify-center [&>svg]:size-4", item.wrap && "h-[18px] self-start", item.active ? "text-accent" : "text-ink-secondary")}
              >
                {item.icon}
              </span>
            )}
            {item.subtitle || item.note ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className={item.wrap ? "break-words" : "truncate"}>{item.label}</span>
                {item.subtitle && <span className="truncate text-[12px] font-normal leading-4 text-ink-secondary">{item.subtitle}</span>}
                {item.note && <span className="text-[12px] font-normal leading-snug text-ink-tertiary">{item.note}</span>}
              </span>
            ) : (
              <span className={cn("flex-1", item.wrap ? "min-w-0 break-words" : "truncate")}>{item.label}</span>
            )}
            {item.value && <span className="shrink-0 text-[13px] font-normal leading-[18px] tabular-nums text-ink-secondary">{item.value}</span>}
            {item.trailing}
            {item.attention && (
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  item.attentionTone === "accent" ? "bg-accent" : "bg-danger",
                )}
              />
            )}
            {(item.submenu || item.chevron) && <ChevronRight size={14} aria-hidden className="-me-0.5 shrink-0 text-ink-secondary rtl:-scale-x-100" />}
          </button>
        </div>
      ))}
    </>
  );
}

const closesOnEscape = (event: ReactKeyboardEvent) =>
  popoverClosesOnKey({ key: event.key, defaultPrevented: event.defaultPrevented, isComposing: event.nativeEvent.isComposing });

export function SidebarPopoverMenu({
  items,
  ariaLabel,
  openOnHover = false,
  placement = "above",
  triggerClassName = "w-full",
  triggerTitle,
  triggerLabel,
  triggerTour,
  onOpenChange,
  renderTrigger,
}: {
  placement?: "above" | "below";
  items: SidebarMenuItem[];
  ariaLabel: string;
  openOnHover?: boolean;
  triggerClassName?: string;
  triggerTitle?: string;
  /** the trigger's own name, when it says more than the menu's */
  triggerLabel?: string;
  triggerTour?: string;
  onOpenChange?: (open: boolean) => void;
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
  const rowsByKey = useRef(new Map<string, HTMLElement>());
  const [engaged, setEngaged] = useState(false);
  const intentRef = useRef<SubmenuIntent | null>(null);
  intentRef.current ??= submenuIntent({
    open: (key) => {
      subRowRef.current = rowsByKey.current.get(key) ?? null;
      setSubPosition(null);
      setSubmenu(key);
    },
    close: () => { setSubmenu(null); setEngaged(false); },
    submenuBox: () => subRef.current?.getBoundingClientRect() ?? null,
  });
  const intent = intentRef.current;
  const focusFirst = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuId = useId();
  const motion = useMenuMotion(open);
  const anchored = placement === "above";
  const reportOpen = useRef(onOpenChange);
  reportOpen.current = onOpenChange;
  useEffect(() => { reportOpen.current?.(open); }, [open]);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  };
  useEffect(() => () => { clearTimers(); intentRef.current?.reset(); }, []);

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
    intentRef.current?.reset();
    setPinned(false);
    setOpen(false);
    setSubmenu(null);
    setEngaged(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const insideRef = useRef({
    contains: (target: unknown) =>
      [rootRef.current, menuRef.current, subRef.current].some((node) => node?.contains(target as Node)),
  });
  usePopoverDismiss(open, insideRef, () => close(anchored));

  useLayoutEffect(() => {
    if (!motion.shown) return;
    const place = () => {
      const trigger = triggerRef.current, menu = menuRef.current;
      if (!trigger || !menu) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      if (anchored) setPosition(anchoredMenuPosition(trigger.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.offsetHeight }, viewport, isRtl(trigger)));
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

  // Focus waits until the anchored sheet is placed: a hidden sheet cannot take focus.
  useEffect(() => {
    if (!open || !focusFirst.current || (anchored && !position)) return;
    focusFirst.current = false;
    menuItems(menuRef.current)[0]?.focus();
  }, [open, anchored, position]);

  const openSub = (item: SidebarMenuItem, row: HTMLElement, focus = false) => {
    rowsByKey.current.set(item.key, row);
    intent.openNow(item.key);
    if (focus) requestAnimationFrame(() => menuItems(subRef.current)[0]?.focus());
  };
  const closeSub = (focusRow = false) => {
    intent.closeNow();
    if (focusRow) subRowRef.current?.focus();
  };

  const selectItem = (item: SidebarMenuItem, row: HTMLElement, keyboard: boolean) => {
    if (item.submenu) {
      if (submenu === item.key) closeSub();
      else openSub(item, row, keyboard);
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
      // preventDefault tells the window's Escape handler this press is handled.
      event.preventDefault();
      event.stopPropagation();
      closeSub(true);
    } else if (!inSubmenu && closesOnEscape(event)) {
      // The menu, not the panel or dialog around it, owns this Escape: an anchored sheet's keys bubble through the
      // portal to the trigger's ancestors before the window ever sees them.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab" && anchored) {
      event.preventDefault();
      close(true);
    }
  };

  const openItem = submenu ? items.find((item) => item.key === submenu) : undefined;
  const sheetClass = cn(MENU_SHEET, "overflow-hidden");

  const sheet = motion.shown && (
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-label={ariaLabel}
      data-sidebar-popover-menu={anchored ? "anchored" : undefined}
      {...motion.exitProps}
      onKeyDown={(event) => onMenuKey(event, false)}
      onPointerMove={(event) => intent.move({ x: event.clientX, y: event.clientY }, Boolean(submenu && subRowRef.current?.contains(event.target as Node)))}
      onPointerLeave={() => intent.leaveMenu()}
      style={anchored ? { position: "fixed", left: position?.left ?? 0, top: position?.top ?? 0, minWidth: MENU_MIN_WIDTH, width: "max-content", maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${EDGE_MARGIN * 2}px))`, maxHeight: `calc(100vh - ${EDGE_MARGIN * 2}px)`, visibility: position ? undefined : "hidden" } : undefined}
      className={cn(
        sheetClass,
        anchored ? "z-[60] overflow-y-auto" : "absolute z-40",
        placement === "below" && "top-full right-0 mt-1 w-72 max-w-[calc(100vw-2rem)]",
        motion.className,
      )}
    >
      <MenuRows
        items={items}
        openSubmenu={submenu}
        engaged={engaged}
        onItem={selectItem}
        onRowEnter={(item, row, point) => {
          if (item.submenu) rowsByKey.current.set(item.key, row);
          intent.enterRow(item.key, Boolean(item.submenu), point);
        }}
        onRowLeave={(item) => intent.leaveRow(item.key)}
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
      onPointerEnter={() => { intent.enterSubmenu(); setEngaged(true); }}
      onPointerLeave={() => setEngaged(false)}
      onFocus={() => setEngaged(true)}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setEngaged(false); }}
      style={{ position: "fixed", left: subPosition?.left ?? 0, top: subPosition?.top ?? 0, minWidth: 200, width: "max-content", maxWidth: `min(${MENU_MAX_WIDTH}px, calc(100vw - ${EDGE_MARGIN * 2}px))`, maxHeight: `calc(100vh - ${EDGE_MARGIN * 2}px)`, visibility: subPosition ? undefined : "hidden" }}
      className={cn(sheetClass, "z-[61] animate-pop-in overflow-y-auto")}
    >
      <MenuRows
        items={openItem.submenu}
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
      onFocus={() => openOnHover && setOpen(true)}
      onBlur={(event) => {
        if (pinned) return;
        if (!event.relatedTarget || !insideRef.current.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel ?? ariaLabel}
        title={triggerTitle}
        data-tour={triggerTour}
        onClick={(event) => {
          clearTimers();
          if (open && (pinned || !openOnHover)) close();
          else {
            // event.detail is 0 for a click from Enter or Space: land on the first item.
            focusFirst.current = anchored && event.detail === 0;
            setPinned(true);
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (open && closesOnEscape(event)) {
            // A menu opened with the mouse leaves focus here; Escape closes it before anything around it.
            event.preventDefault();
            event.stopPropagation();
            close(true);
            return;
          }
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
        : <>{sheet}{typeof document !== "undefined" && subSheet ? createPortal(subSheet, document.body) : null}</>}
    </div>
  );
}
