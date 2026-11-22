import { Eye, Loader2, MousePointer2 } from "lucide-react";

import { PILL_ACTION, type ViewerPillState } from "@/lib/handoff";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

const BUTTON = "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-medium leading-5 transition-colors duration-[120ms] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none pointer-coarse:h-9";

/**
 * The one control over a full-size browser or computer: whether the person watches or drives it, and the single button
 * that changes that. Stop hands control back; I'm done also answers the bot's request.
 */
export function ViewerPill({ state, busy = false, onTake, onStop, onDone, className }: {
  state: ViewerPillState;
  /** The button's change is on its way. */
  busy?: boolean;
  onTake: () => void;
  onStop: () => void;
  onDone: () => void;
  className?: string;
}) {
  const action = PILL_ACTION[state];
  const watching = state === "watching";
  const press = action === "take" ? onTake : action === "stop" ? onStop : onDone;
  const label = t(action === "take" ? "computer.takeControl" : action === "stop" ? "viewer.stop" : "handoff.done");
  return (
    <div
      role="group"
      aria-label={t("viewer.controls")}
      data-viewer-pill={state}
      className={cn("pointer-events-auto inline-flex h-9 items-center gap-2.5 rounded-full bg-composer ps-3 pe-1 text-[13px] shadow-(--shadow-float) ring-[0.5px] ring-ink/10 pointer-coarse:h-11", className)}
    >
      <span role="status" aria-live="polite" className={cn("flex items-center gap-1.5 whitespace-nowrap", watching ? "text-ink-secondary" : "font-medium text-ink")}>
        {watching ? <Eye size={14} aria-hidden="true" /> : <MousePointer2 size={14} aria-hidden="true" />}
        {t(watching ? "viewer.watching" : "computer.inControl")}
      </span>
      <button
        type="button"
        onClick={press}
        disabled={busy}
        aria-busy={busy || undefined}
        className={cn(BUTTON, action === "stop" ? "bg-ink/[0.07] text-ink enabled:hover:bg-ink/[0.11]" : "ui-button-primary bg-ink text-app enabled:hover:bg-ink/90")}
      >
        {busy && <Loader2 size={13} aria-hidden="true" className="motion-safe:animate-spin" />}
        {label}
      </button>
    </div>
  );
}
