// The one shape every in-chat ask shares: a question with choices, a key
// to paste, an app to sign in to. While it waits it is a compact card with
// its title in the accent ink, an optional line on why, and the one control
// that answers it. Once answered it folds into a single quiet line, the way
// a settled approval does, so a long chat does not keep a stack of boxes
// for things that are already done.
import type { KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Check, X } from "lucide-react";

export function AskCard({
  icon,
  plain = false,
  title,
  meta,
  explanation,
  onDismiss,
  dismissLabel,
  ariaLabel,
  tour,
  children,
  footer,
  onKeyDown,
}: {
  icon?: ReactNode;
  /** the title is the ask itself (a question), in plain ink that wraps,
   * rather than an accent label */
  plain?: boolean;
  title: ReactNode;
  /** small trailing text on the title line, such as "1 of 2 answered" */
  meta?: ReactNode;
  /** one short line on why the bot is asking */
  explanation?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  ariaLabel: string;
  tour?: string;
  children?: ReactNode;
  footer?: ReactNode;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-tour={tour}
      data-ask-card="pending"
      onKeyDown={onKeyDown}
      // the composer's own surface, so an ask reads as part of the
      // conversation's controls (the approval row uses the same)
      className="w-full max-w-[600px] rounded-3xl bg-composer px-4 py-3 text-start ring-1 ring-composer-ring"
    >
      <div className={cn("flex min-w-0 gap-2", plain ? "items-start" : "items-center")}>
        {icon && <span aria-hidden="true" className="flex shrink-0 text-accent-text">{icon}</span>}
        {/* the direction goes on the text, not the box: an English title
            in a right-to-left chat still sits beside its icon */}
        <div
          className={cn(
            "min-w-0 flex-1",
            plain
              ? "break-words text-[15px] font-semibold leading-6 text-ink"
              : "truncate text-[13.5px] font-semibold text-accent-text",
          )}
        >
          <bdi dir="auto">{title}</bdi>
        </div>
        {meta && <span className="shrink-0 text-[11.5px] tabular-nums text-ink-tertiary">{meta}</span>}
        {onDismiss && dismissLabel && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            title={dismissLabel}
            className={cn(
              "-me-1.5 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink",
              plain ? "-mt-0.5" : "-my-1",
            )}
          >
            <X size={plain ? 16 : 14} />
          </button>
        )}
      </div>
      {explanation && <div className="mt-1 text-[13px] leading-snug text-ink-secondary">{explanation}</div>}
      {children && <div className={plain ? "mt-3" : "mt-2.5"}>{children}</div>}
      {footer && <div className="mt-3 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
    </div>
  );
}

/** The answered ask: one quiet line, with room for a trailing action
 * (Details, Try again) and an optional block under it. */
export function AskSettledLine({
  icon,
  children,
  action,
  detail,
  ariaLabel,
}: {
  /** defaults to a green tick */
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  detail?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-ask-card="settled"
      className="w-full max-w-[600px] text-start text-[12.5px] text-ink-tertiary"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="flex shrink-0">
          {icon ?? <Check size={13} className="text-success/80" />}
        </span>
        <span dir="auto" aria-live="polite" className="min-w-0 truncate">{children}</span>
        {action}
      </div>
      {detail}
    </div>
  );
}

/**
 * One type and box for every control on an ask, the same as the approval
 * row: 28px tall, rounded-full, 13px at weight 500 in a 20px line box
 * centered in that height, and one 6px gap between an icon and its label.
 * A fixed height with a centered line box keeps Arabic and Latin labels on
 * the same baseline band, where vertical padding alone lets each script's
 * font metrics push the text off center. Rows of controls use an 8px gap.
 */
const ASK_CONTROL =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors [&>svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40";

/** The main action: the accent fill. `accent-ink` rather than white, since
 * Foundry's brass accent needs dark ink to stay readable. */
export const ASK_PRIMARY_BUTTON =
  `${ASK_CONTROL} bg-accent text-accent-ink hover:brightness-110`;

/** A choice. The same height and type as the main action, a neutral tint
 * until it is picked, then outlined and tinted with the accent. */
export const ASK_CHIP = `${ASK_CONTROL} max-w-full border`;
/** The approval row's neutral fill: a tint of the ink, so it shows on the
 * composer surface in every skin, where a hairline border does not. */
export const ASK_CHIP_IDLE = "border-transparent bg-ink/[0.07] text-ink hover:bg-ink/[0.12]";
export const ASK_CHIP_PICKED = "border-accent bg-accent/15 text-ink";

/** Question tabs, and the quiet actions on a settled line (Details,
 * Continue task, Try again). Same box and type, no fill until hovered. */
export const ASK_SMALL_PILL = ASK_CONTROL;
/** The negative margin keeps a settled line one text line tall while the
 * button keeps its full 28px target. */
export const ASK_QUIET_BUTTON = `${ASK_SMALL_PILL} -my-1 text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink-secondary`;

/** A one-line field beside a button: the button's height and type. */
export const ASK_FIELD =
  "h-7 rounded-full border border-hairline/60 bg-inset px-3 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";

/** An answered ask folds away with the control that answered it, which
 * would drop keyboard focus onto the page. Hand it to the composer, where
 * the conversation continues. */
export function returnFocusToComposer(): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
}

/** Arrow keys walk a row of choices the way they walk a radio group. Left
 * and Right follow the reading direction, so in a right-to-left chat the
 * arrow pointing forward still moves forward. */
export function moveChoiceFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget;
  const items = Array.from(group.querySelectorAll<HTMLElement>("[data-ask-choice]:not([disabled])"));
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const rtl = getComputedStyle(group).direction === "rtl";
  const forward = event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const backward = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (forward) next = current < 0 ? 0 : (current + 1) % items.length;
  else if (backward) next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}
