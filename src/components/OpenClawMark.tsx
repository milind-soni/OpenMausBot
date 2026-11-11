// OpenClaw's lobster mark (openclaw/openclaw, MIT), drawn in one colour like the other marks.
import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

export function OpenClawMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="currentColor" className={cn("text-ink", className)} aria-hidden>
      <path fillRule="evenodd" d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z M45 29 a6 6 0 1 0 0.01 0Z M75 29 a6 6 0 1 0 0.01 0Z" />
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" />
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" />
      <path d="M45 15 Q35 5 30 8 M75 15 Q85 5 90 8" fill="none" stroke="currentColor" strokeWidth={6} strokeLinecap="round" />
    </svg>
  );
}
