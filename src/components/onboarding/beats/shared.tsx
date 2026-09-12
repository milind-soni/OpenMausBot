// Small pieces every beat of the welcome flow shares, so the beats read as
// one surface: the same input, the same primary button.
import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { MausMotion, MausState } from "@/lib/mascot";

/** What a beat can do to the flow around it. Every beat can move on or be
 * skipped; the guide mascot is shared, so a beat borrows it rather than
 * owning one. */
export interface BeatProps {
  onNext: () => void;
  /** Same destination as onNext; separate so analytics can tell them apart. */
  onSkip: () => void;
  setMascot: (state: MausState) => void;
  /** Fire a one-shot motion on the guide (`success`, `celebrate`, …). */
  bump: (motion: Exclude<MausMotion, "none">) => void;
}

export const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none";

/** Index for the `.stagger` utility; each sibling arrives 40ms after the last. */
export function staggerIndex(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

export function PrimaryButton({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      data-primary=""
      {...rest}
      className={cn(
        "w-full shrink-0 rounded-lg bg-accent py-2.5 text-[15px] font-medium text-white transition-[transform,opacity] duration-150 active:scale-[0.98] disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function QuietButton({
  children,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={cn("text-[12px] text-ink-secondary transition-colors hover:text-ink", className)}
    >
      {children}
    </button>
  );
}

