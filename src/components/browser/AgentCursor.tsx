// Adapted from pingdotgg/t3code@00cdceb1 apps/web/src/components/preview/AgentBrowserCursor.tsx (AgentCursorMark) and
// agentBrowserCursorLogic.ts, MIT License, Copyright (c) 2026 T3 Tools Inc. (full text in third_party/t3-code/LICENSE);
// modified: OpenMausBot's colours.
import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

const CURSOR_ACTIVE_MS = 700;

export type CursorController = "human" | "agent" | "none";

export function agentCursorOpacity(active: boolean, controller: CursorController): number {
  if (active) return 1;
  return controller === "human" ? 0.18 : 0.35;
}

/** The bot's pointer at a surface position; it fades once the bot stops acting. */
export function AgentCursor({ phase, sequence, left, top, controller }: {
  phase: "move" | "click";
  sequence: number;
  left: number;
  top: number;
  controller: CursorController;
}) {
  const [inactiveSequence, setInactiveSequence] = useState<number | null>(null);
  const active = inactiveSequence !== sequence;
  useEffect(() => {
    const timeout = window.setTimeout(() => setInactiveSequence(sequence), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [sequence]);
  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-30 transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none"
      style={{ opacity: agentCursorOpacity(active, controller), transform: `translate3d(${left}px, ${top}px, 0)` }}
      aria-hidden="true"
      data-agent-cursor
    >
      {phase === "click" ? <span key={sequence} className="absolute left-0.5 top-0.5 size-4 animate-ping rounded-full bg-accent/25 motion-reduce:animate-none" /> : null}
      <MousePointer2 className="relative size-5 -translate-x-0.5 -translate-y-0.5 fill-card text-accent drop-shadow-sm" strokeWidth={2} />
    </div>
  );
}
