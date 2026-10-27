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
  plain?: boolean;
  title: ReactNode;
  meta?: ReactNode;
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
      className="w-full max-w-[600px] rounded-2xl bg-composer px-4 py-3 text-start ring-1 ring-composer-ring"
    >
      <div className={cn("flex min-w-0 gap-2", plain ? "items-start" : "items-center")}>
        {icon && <span aria-hidden="true" className="flex shrink-0 text-accent-text">{icon}</span>}
        <div
          className={cn(
            "min-w-0 flex-1",
            plain
              ? "break-words text-[15px] font-semibold leading-6 text-ink"
              : "truncate text-[14px] font-semibold text-accent-text",
          )}
        >
          <bdi dir="auto">{title}</bdi>
        </div>
        {meta && <span className="shrink-0 text-[12px] tabular-nums text-ink-tertiary">{meta}</span>}
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

export function AskSettledLine({
  icon,
  children,
  action,
  detail,
  ariaLabel,
}: {
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
      className="w-full max-w-[600px] text-start text-[13px] text-ink-tertiary"
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
 * A fixed height with a centered line box keeps Arabic and Latin labels on one baseline band; vertical padding lets
 * each script's font metrics push text off center.
 */
const ASK_CONTROL =
  "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors [&>svg]:shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40";

export const ASK_PRIMARY_BUTTON =
  `${ASK_CONTROL} bg-accent text-accent-ink hover:brightness-110`;

export const ASK_CHIP = `${ASK_CONTROL} max-w-full border`;
export const ASK_CHIP_IDLE = "border-transparent bg-ink/[0.07] text-ink hover:bg-ink/[0.12]";
export const ASK_CHIP_PICKED = "border-accent bg-accent/15 text-ink";

export const ASK_SMALL_PILL = ASK_CONTROL;
export const ASK_QUIET_BUTTON = `${ASK_SMALL_PILL} -my-1 text-ink-tertiary hover:bg-ink/[0.07] hover:text-ink-secondary`;

export const ASK_FIELD =
  "h-7 rounded-full border border-hairline/60 bg-inset px-3 text-[13px] leading-5 text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60";

export function returnFocusToComposer(): void {
  if (typeof requestAnimationFrame !== "function") return;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-tour="composer"] textarea')?.focus());
}

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
