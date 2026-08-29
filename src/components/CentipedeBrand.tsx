import { cn } from "@/lib/cn";

type MarkProps = {
  className?: string;
  title?: string;
};

/**
 * The Agent Centipede mark is code-native SVG so it remains razor sharp in
 * the title bar, sidebar, onboarding, and every exported size. The uneven
 * segment rhythm keeps it clinical without becoming corporate wallpaper.
 */
export function CentipedeMark({ className, title = "Agent Centipede" }: MarkProps) {
  return (
    <svg
      viewBox="0 0 64 40"
      role="img"
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <path d="M12 15 8 9M12 25 8 31M22 13 19 6M22 27 19 34M32 13V5M32 27v8M42 13l3-7M42 27l3 7M52 15l5-5M52 25l5 5" />
        <path d="M7 16 3 13M7 24l-4 3M57 17l4-3M57 23l4 3" />
      </g>
      <g stroke="currentColor" strokeWidth="1.8">
        <circle cx="9" cy="20" r="6" fill="var(--color-accent)" />
        <rect x="15" y="12" width="12" height="16" rx="5" fill="var(--color-accent)" />
        <rect x="27" y="11" width="12" height="18" rx="5" fill="var(--color-accent)" />
        <rect x="39" y="12" width="11" height="16" rx="5" fill="var(--color-accent)" />
        <circle cx="55" cy="20" r="6" fill="var(--color-accent)" />
      </g>
      <circle cx="57" cy="18" r="1.4" fill="var(--color-accent-ink)" stroke="none" />
    </svg>
  );
}

export function CentipedeBrand({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <span className="centipede-mark-frame flex size-9 shrink-0 items-center justify-center rounded-lg border border-accent/45 bg-accent/10 text-accent">
        <CentipedeMark className="h-6 w-8" />
      </span>
      {!compact && (
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-extrabold uppercase tracking-[0.12em] text-ink">
            Agent Centipede
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9px] uppercase tracking-[0.16em] text-ink-secondary">
            Agent harness · live
          </span>
        </span>
      )}
    </div>
  );
}
