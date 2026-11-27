// Adapted from pingdotgg/t3code@a16796b9 packages/provider-cursor/src/client.ts (the provider icon; the same path is
// CursorIcon in apps/web/src/components/Icons.tsx), MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in
// third_party/t3-code/LICENSE); modified: drawn in the ink colour, which inverts with the skin, instead of its fixed
// light and dark fills. The mark itself is Cursor's, shown only to identify the Cursor provider.
import { cn } from "@/lib/cn";

interface IconProps {
  size?: number;
  className?: string;
}

/** Cursor's cube mark: a hexagon with the cursor facet cut out of it. */
export function CursorMark({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 466.73 532.09" className={cn("fill-[var(--color-ink)]", className)} aria-hidden>
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  );
}
