// Official Cursor mark (cursor.com favicon / wordmark companion). The brand
// asset is near-white because it is drawn for a dark UI; kept as a fixed
// colour it vanished on every light skin. Monochrome marks take --color-ink
// here, the way the Grok, Codex and Kimi marks already do.
import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

export function CursorMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[var(--color-ink)]", className)} aria-hidden>
      <path d="M4 2.2 20.6 12 12.7 13.9 10.4 21.8z" />
    </svg>
  );
}
