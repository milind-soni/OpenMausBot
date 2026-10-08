import { useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { popoverClosesOnKey, usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Class shared by every control that lives inside the tray: the tray decides
 * when the row is visible, so the buttons themselves never fade. */
export const messageActionClass =
  "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

/** "auto" follows hover and keyboard focus. "held" keeps the tray out after
 * the pointer leaves. "tucked" keeps it in while the pointer or focus that
 * would reveal it is still there, so closing it from the handle shows. */
type TrayMode = "auto" | "held" | "tucked";

function focusVisible(target: EventTarget | null): boolean {
  try {
    return target instanceof Element && target.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** One "…" handle beside a bubble. Hovering or keyboard-focusing it slides
 * the row of message controls out sideways — away from the bubble — so an
 * idle message shows a single quiet dot cluster instead of a heap of icons.
 *
 * Clicking the handle flips what is on screen: a tray that hover or focus
 * already opened tucks back, and a closed one comes out and stays out until
 * the handle, Escape or a press outside closes it. `forceOpen` keeps it out
 * while a control needs to stay reachable (a message being read aloud, raw
 * markdown showing). Children render in reading order; the tray mirrors them
 * on the user side so the first control stays nearest the bubble on both
 * sides. */
export function MessageActions({
  side,
  forceOpen = false,
  className,
  children,
}: {
  side: "user" | "bot";
  forceOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const pointerType = useRef("");
  const [mode, setMode] = useState<TrayMode>("auto");
  const [hovered, setHovered] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const held = forceOpen || mode === "held";
  const open = held || (mode === "auto" && (hovered || keyboardFocus));
  const mirrored = side === "user";
  usePopoverDismiss(mode === "held", rootRef, () => setMode(hovered || keyboardFocus ? "tucked" : "auto"));
  const toggle = () => {
    // a mouse on the handle or a keyboard on it has already opened an "auto"
    // tray; a tap has no hover, so for touch it is still closed
    const shown = held || (mode === "auto" && pointerType.current !== "touch");
    pointerType.current = "";
    setMode(shown ? "tucked" : "held");
  };
  return (
    <div
      ref={rootRef}
      className={cn("group/actions flex items-center self-end pb-0.5", mirrored && "flex-row-reverse", className)}
      data-testid="message-actions"
      data-open={held ? "true" : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType !== "touch") setHovered(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "touch") return;
        setHovered(false);
        if (mode === "tucked" && !keyboardFocus) setMode("auto");
      }}
      onFocus={(e) => {
        setKeyboardFocus(focusVisible(e.target));
        if (mode === "tucked" && (e.target as EventTarget) !== handleRef.current) setMode("auto");
      }}
      onBlur={(e) => {
        if (e.relatedTarget instanceof Node && rootRef.current?.contains(e.relatedTarget)) return;
        setKeyboardFocus(false);
        if (mode === "tucked" && !hovered) setMode("auto");
      }}
      onKeyDown={(e) => {
        if (!open || forceOpen || !popoverClosesOnKey(e.nativeEvent)) return;
        e.preventDefault();
        setMode("tucked");
      }}
    >
      <button
        ref={handleRef}
        type="button"
        onPointerDown={(e) => {
          pointerType.current = e.pointerType;
        }}
        onClick={toggle}
        aria-label={t("chat.messageActions")}
        title={t("chat.messageActions")}
        aria-expanded={open}
        className={cn(
          "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-70",
          held ? "bg-raised text-ink opacity-100 touch:opacity-100" : "opacity-0",
        )}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      <div
        className={cn(
          "grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out",
          held
            ? "grid-cols-[1fr]"
            : mode === "auto" && "group-hover/actions:grid-cols-[1fr] group-has-[:focus-visible]/actions:grid-cols-[1fr]",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-0.5 overflow-hidden", mirrored && "flex-row-reverse")}>
          {children}
        </div>
      </div>
    </div>
  );
}
