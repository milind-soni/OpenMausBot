import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { popoverClosesOnKey, usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** One size and stroke for every icon beside a message and in its menu:
 * thin rounded outlines, like the rest of the chat chrome. */
export const ACTION_ICON = { size: 17, strokeWidth: 1.5 } as const;

/** Class shared by every control that lives in the row: the row decides
 * when it is visible, so the buttons themselves never fade. One muted
 * colour that brightens on hover. */
export const messageActionClass =
  "inline-flex size-7 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";

export type MessageMenuItem = {
  key: string;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  title?: string;
  disabled?: boolean;
};

/** Where a message row starts: the element that hovering, focusing or
 * tapping reveals the actions for. */
export const MESSAGE_ROW = "data-message-row";

const INTERACTIVE = "a, button, input, textarea, select, summary, label, [role=button], [contenteditable=true]";
const LONG_PRESS_MS = 450;

function focusVisible(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && target.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** Reply, copy and a "more" menu beside a bubble. They show only while the
 * pointer is over the message, or keyboard focus is inside it, and on a
 * touch screen after a tap or a long press on the message. The menu holds
 * the rest (read aloud, raw markdown, pin, regenerate, copy id) and closes
 * on Escape or a press outside. `forceOpen` keeps the row out while a
 * control in it has to stay reachable, like the stop button of a message
 * being read aloud. Children render in reading order; the row mirrors on
 * the user side so the first control stays nearest the bubble. */
export function MessageActions({
  side,
  forceOpen = false,
  className,
  menu = [],
  children,
}: {
  side: "user" | "bot";
  forceOpen?: boolean;
  className?: string;
  menu?: MessageMenuItem[];
  children?: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLElement | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAbove, setMenuAbove] = useState(false);
  // the menu hangs from the row's start edge unless that runs off the window
  const [menuFlipped, setMenuFlipped] = useState(false);
  const mirrored = side === "user";
  const shown = forceOpen || menuOpen || hovered || keyboardFocus || tapped;

  // The message row, not just this strip, reveals the actions.
  useEffect(() => {
    const row = rootRef.current?.closest<HTMLElement>(`[${MESSAGE_ROW}]`) ?? rootRef.current;
    rowRef.current = row;
    if (!row) return;
    let press: { x: number; y: number; at: number; timer: ReturnType<typeof setTimeout> } | null = null;
    const enter = (event: PointerEvent) => { if (event.pointerType !== "touch") setHovered(true); };
    const leave = (event: PointerEvent) => { if (event.pointerType !== "touch") setHovered(false); };
    const focusIn = (event: FocusEvent) => setKeyboardFocus(focusVisible(event.target));
    const focusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
      setKeyboardFocus(false);
    };
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(rootRef.current?.contains(target));
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || inside(event.target)) return;
      if (press) clearTimeout(press.timer);
      press = { x: event.clientX, y: event.clientY, at: Date.now(), timer: setTimeout(() => setTapped(true), LONG_PRESS_MS) };
    };
    const move = (event: PointerEvent) => {
      if (!press || event.pointerType !== "touch") return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
        clearTimeout(press.timer);
        press = null;
      }
    };
    const cancel = () => {
      if (press) clearTimeout(press.timer);
      press = null;
    };
    const up = (event: PointerEvent) => {
      if (!press || event.pointerType !== "touch") return;
      clearTimeout(press.timer);
      const quick = Date.now() - press.at < LONG_PRESS_MS;
      press = null;
      // a tap on a link or a button does its own thing, and a tap that
      // ends a text selection is not asking for the actions
      if (!quick || (event.target instanceof Element && event.target.closest(INTERACTIVE))) return;
      if (window.getSelection()?.toString()) return;
      setTapped((value) => !value);
    };
    row.addEventListener("pointerenter", enter);
    row.addEventListener("pointerleave", leave);
    row.addEventListener("focusin", focusIn);
    row.addEventListener("focusout", focusOut);
    row.addEventListener("pointerdown", down);
    row.addEventListener("pointermove", move);
    row.addEventListener("pointerup", up);
    row.addEventListener("pointercancel", cancel);
    return () => {
      if (press) clearTimeout(press.timer);
      row.removeEventListener("pointerenter", enter);
      row.removeEventListener("pointerleave", leave);
      row.removeEventListener("focusin", focusIn);
      row.removeEventListener("focusout", focusOut);
      row.removeEventListener("pointerdown", down);
      row.removeEventListener("pointermove", move);
      row.removeEventListener("pointerup", up);
      row.removeEventListener("pointercancel", cancel);
    };
  }, []);

  // a tap elsewhere puts a tap-revealed row away again
  usePopoverDismiss(tapped && !menuOpen, rowRef, () => setTapped(false));
  usePopoverDismiss(menuOpen, rootRef, () => {
    setMenuOpen(false);
    if (rootRef.current?.contains(document.activeElement)) moreRef.current?.focus();
  });

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menuBox = menuRef.current?.getBoundingClientRect();
    const more = moreRef.current?.getBoundingClientRect();
    // below the button unless that runs off the window
    if (menuBox && more) setMenuAbove(more.bottom + 4 + menuBox.height > window.innerHeight - 8 && more.top - 4 - menuBox.height > 8);
    const rowBox = rootRef.current?.getBoundingClientRect();
    if (menuBox && rowBox) {
      const rtl = getComputedStyle(rootRef.current!).direction === "rtl";
      const fitsRight = rowBox.left + menuBox.width <= window.innerWidth - 8;
      const fitsLeft = rowBox.right - menuBox.width >= 8;
      const fitsStart = rtl ? fitsLeft : fitsRight;
      const fitsEnd = rtl ? fitsRight : fitsLeft;
      setMenuFlipped(mirrored ? !fitsEnd && fitsStart : !fitsStart && fitsEnd);
    }
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
  }, [menuOpen]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null || !items.length) {
      if (event.key === "Tab") setMenuOpen(false);
      return;
    }
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative flex items-center gap-0.5 self-end pb-0.5 transition-opacity duration-150",
        mirrored && "flex-row-reverse",
        shown ? "opacity-100" : "pointer-events-none opacity-0",
        className,
      )}
      data-testid="message-actions"
      data-shown={shown ? "true" : undefined}
      onKeyDown={(event) => {
        if (menuOpen || forceOpen || !popoverClosesOnKey(event.nativeEvent) || !keyboardFocus) return;
        // Escape from a focused control hands focus back to the message
        event.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur();
      }}
    >
      {children}
      {menu.length > 0 && (
        <button
          ref={moreRef}
          type="button"
          onClick={() => setMenuOpen((value) => !value)}
          aria-label={t("chat.messageActions")}
          title={t("chat.messageActions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          className={cn(messageActionClass, menuOpen && "bg-ink/10 text-ink")}
        >
          <Ellipsis {...ACTION_ICON} aria-hidden="true" />
        </button>
      )}
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t("chat.messageActions")}
          onKeyDown={moveFocus}
          className={cn(
            "absolute z-40 min-w-52 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50",
            menuAbove ? "bottom-full mb-1" : "top-full mt-1",
            mirrored !== menuFlipped ? "end-0" : "start-0",
          )}
        >
          {menu.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                item.onSelect();
                setMenuOpen(false);
                moreRef.current?.focus();
              }}
              className="flex w-full items-center gap-3 px-3.5 py-2 text-start text-[14px] text-ink hover:bg-raised/70 focus-visible:bg-raised/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-ink-secondary" aria-hidden="true">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
