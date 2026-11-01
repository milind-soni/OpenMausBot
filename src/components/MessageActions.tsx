import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, Copy, Ellipsis, Reply, X } from "lucide-react";
import { popoverClosesOnKey, usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { MENU_ITEM, MENU_SHEET } from "./menu-recipe";

export const ACTION_ICON = { size: 17, strokeWidth: 1.5 } as const;

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
  const [menuFlipped, setMenuFlipped] = useState(false);
  const mirrored = side === "user";
  const shown = forceOpen || menuOpen || hovered || keyboardFocus || tapped;

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

  usePopoverDismiss(tapped && !menuOpen, rowRef, () => setTapped(false));
  usePopoverDismiss(menuOpen, rootRef, () => {
    setMenuOpen(false);
    if (rootRef.current?.contains(document.activeElement)) moreRef.current?.focus();
  });

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menuBox = menuRef.current?.getBoundingClientRect();
    const more = moreRef.current?.getBoundingClientRect();
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
            "absolute z-40 min-w-52 max-w-[calc(100vw-2rem)] overflow-hidden", MENU_SHEET,
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
              className={cn(MENU_ITEM, "text-start text-ink hover:bg-menu-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60")}
            >
              <span className="flex size-4 shrink-0 items-center justify-center text-ink-secondary [&>svg]:size-4" aria-hidden="true">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReplyAction({ onReply }: { onReply: () => void }) {
  return (
    <button type="button" onClick={onReply} aria-label={t("chat.replyToMessage")} title={t("chat.reply")} className={messageActionClass}>
      <Reply {...ACTION_ICON} aria-hidden="true" />
    </button>
  );
}

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const { state, copy } = useCopyFeedback(text);
  const label = t(state === "copied" ? "chat.copyMessageDone" : state === "failed" ? "chat.copyMessageFailed" : "chat.copyMessage");
  return (
    <button
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        state !== "idle" && "opacity-100",
        className,
      )}
    >
      {state === "copied" ? <Check {...ACTION_ICON} className="text-success" /> : state === "failed" ? <X {...ACTION_ICON} className="text-danger" /> : <Copy {...ACTION_ICON} />}
    </button>
  );
}
