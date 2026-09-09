// Left-edge tail: mascot looks around while it works, with a live activity
// sheen beside it. The moment there is an answer, the label is gone while
// the canonical transcript row performs the settle-in animation above it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { WorkingTimer } from "@/components/WorkingIndicator";

export function TurnPresence({
  avatar,
  visible,
  label = "Thinking",
  answering = false,
  since = null,
}: {
  avatar: ReactNode;
  visible: boolean;
  label?: string;
  answering?: boolean;
  /** Turn start (epoch ms) — shows a self-ticking elapsed readout while working. */
  since?: number | null;
}) {
  const [mounted, setMounted] = useState(visible);
  const [phase, setPhase] = useState<"think" | "answer" | "out">(answering ? "answer" : "think");
  const wasAnswering = useRef(answering);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setPhase(answering ? "answer" : "think");
      wasAnswering.current = answering;
      return;
    }
    if (!mounted) return;
    const handoff = wasAnswering.current;
    wasAnswering.current = false;
    if (handoff) {
      setMounted(false);
      return;
    }
    setPhase("out");
    const timer = setTimeout(() => setMounted(false), 280);
    return () => clearTimeout(timer);
  }, [visible, answering, mounted]);

  if (!mounted) return null;
  const showWorking = phase === "think";
  return (
    <div className="turn-presence flex flex-col items-start">
      <div
        className={cn(
          "flex items-center gap-2",
          phase === "think" && "turn-mascot-in",
          phase === "out" && "turn-mascot-out",
        )}
      >
        {avatar}
        {showWorking ? (
          <span className="flex items-baseline gap-2 leading-none">
            <span className="thinking-shimmer animate-shimmer text-[13px]" aria-live="polite">
              {label}
            </span>
            {since !== null && (
              <WorkingTimer since={since} className="text-[11.5px] text-ink-secondary/70" />
            )}
          </span>
        ) : null}
      </div>
    </div>
  );
}
