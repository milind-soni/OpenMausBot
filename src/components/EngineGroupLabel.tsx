import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EngineGroupLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary",
        className,
      )}
    >
      {children}
    </div>
  );
}
