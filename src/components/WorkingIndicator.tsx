// Duty-cycled activity indicators. A spinner repaints every vsync for its
// whole lifetime; these dots step through a few opacity holds per cycle,
// and the timer mutates its own text node once a second instead of
// committing through React. Long-lived indicators must stay this cheap.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { formatElapsed } from "@/lib/working-time";

export function WorkingDots({ size = 4, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1", className)} aria-hidden="true">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="animate-status-pulse rounded-full bg-current"
          style={{ width: size, height: size, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/** Self-ticking elapsed readout — counts up from `since` (epoch ms). */
export function WorkingTimer({ since, className }: { since: number; className?: string }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (node.current) node.current.textContent = formatElapsed(Date.now() - since);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={node} className={cn("tabular-nums", className)} />;
}
