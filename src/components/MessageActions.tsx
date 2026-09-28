import { useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

/** Class shared by every control that lives inside the tray: the tray decides
 * when the row is visible, so the buttons themselves never fade. */
export const messageActionClass =
  "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

/** One "…" handle beside a bubble. Hovering or focusing it slides the row of
 * message controls out sideways — away from the bubble — so an idle message
 * shows a single quiet dot cluster instead of a heap of icons.
 *
 * Click toggles the tray open for touch and keyboard, and `forceOpen` keeps
 * it out while a control needs to stay reachable (a message being read
 * aloud, raw markdown showing). Children render in reading order; the tray
 * mirrors them on the user side so the first control stays nearest the
 * bubble on both sides. */
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
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const open = pinnedOpen || forceOpen;
  const mirrored = side === "user";
  return (
    <div
      className={cn("group/actions flex items-center self-end pb-0.5", mirrored && "flex-row-reverse", className)}
      data-testid="message-actions"
      data-open={open ? "true" : undefined}
    >
      <button
        type="button"
        onClick={() => setPinnedOpen((v) => !v)}
        aria-label={t("chat.messageActions")}
        title={t("chat.messageActions")}
        aria-expanded={open}
        className={cn(
          "rounded-md p-1.5 text-ink-secondary transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100",
          open ? "bg-raised text-ink opacity-100" : "opacity-0",
        )}
      >
        <Ellipsis size={14} aria-hidden="true" />
      </button>
      <div
        className={cn(
          "grid grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-hover/actions:grid-cols-[1fr] group-focus-within/actions:grid-cols-[1fr]",
          open && "grid-cols-[1fr]",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-0.5 overflow-hidden", mirrored && "flex-row-reverse")}>
          {children}
        </div>
      </div>
    </div>
  );
}
