import type { CSSProperties } from "react";
import { cn } from "@/lib/cn";
import type { MausMotion, MausState } from "@/lib/mascot";

export interface BeatProps {
  onNext: () => void;
  onSkip: () => void;
  setMascot: (state: MausState) => void;
  bump: (motion: Exclude<MausMotion, "none">) => void;
}

export const inputClass =
  "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-secondary focus:outline-none";

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

