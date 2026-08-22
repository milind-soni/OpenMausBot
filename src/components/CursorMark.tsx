// Official Cursor mark (cursor.com favicon / wordmark companion).
import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

export function CursorMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={cn("fill-[#F5F5F5]", className)} aria-hidden>
      <path d="M4 2.2 20.6 12 12.7 13.9 10.4 21.8z" />
    </svg>
  );
}
