import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { LayerKind } from "../../../shared/skill-burger/layers";
import { cn } from "@/lib/cn";
import { LayerIcon } from "./SkillBurger";

/** At most this many app marks: a long run never turns the pill into a bar. */
export const PILL_ICONS = 4;

export interface PillMark { kind: LayerKind; app?: string }

/** The marks a pill shows: each app or kind of step once, the most recent last, at most PILL_ICONS. */
export function pillMarks(steps: readonly PillMark[]): PillMark[] {
  const seen = new Map<string, PillMark>();
  for (const step of steps) {
    const key = step.kind === "app" && step.app ? `app:${step.app}` : step.kind;
    seen.delete(key);
    seen.set(key, step);
  }
  return [...seen.values()].slice(-PILL_ICONS);
}

const markKey = (mark: PillMark) => (mark.kind === "app" && mark.app ? `app:${mark.app}` : mark.kind);

/** "{count} steps" with the number as its own element, so it can tick over in place. */
export function WithCount({ template, count }: { template: string; count: number }) {
  const [before, after = ""] = template.split("{count}");
  return (
    <>
      {before}
      <span key={count} className="burger-tick inline-block tabular-nums">{count}</span>
      {after}
    </>
  );
}

const SHEEN_PERIOD_MS = 2000;

/** Words that cook: the same slow sheen as a bot's working phrase, none with reduced motion. */
export function Sheen({ children, text }: { children: ReactNode; text: string }) {
  const [delay] = useState(() => `-${Date.now() % SHEEN_PERIOD_MS}ms`);
  return (
    <span className="thinking-shimmer min-w-0 truncate" style={{ "--sheen-period": `${SHEEN_PERIOD_MS}ms`, "--sheen-delay": delay } as CSSProperties}>
      {children}
      <span aria-hidden="true" className="thinking-sheen"><span data-text={text} /></span>
    </span>
  );
}

/** The Skill Burger in the chat: a small pill with the run's app marks, its count and one action. Its steps open above it
 * only when someone taps it, never on their own; the pill grows a little as marks are added, smoothly. */
export function BurgerPill({ marks, label, tone = "normal", open, controls, toggleLabel, onToggle, action }: {
  marks: readonly PillMark[];
  label: ReactNode;
  tone?: "normal" | "danger";
  open: boolean;
  controls: string;
  toggleLabel: string;
  onToggle: () => void;
  action?: ReactNode;
}) {
  const inner = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const node = inner.current;
    if (!node) return;
    const measure = () => setWidth(Math.ceil(node.scrollWidth));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  });
  const newest = marks.length ? markKey(marks[marks.length - 1]!) : "";
  return (
    <div
      data-burger-pill=""
      className="burger-pill h-9 max-w-full overflow-hidden rounded-full bg-raised shadow-sm transition-[width] duration-200 ease-out motion-reduce:transition-none"
      style={width === undefined ? undefined : { width }}
    >
      <div ref={inner} className="flex h-9 w-max items-center gap-1 pe-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={controls}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggle}
          className="flex h-9 min-w-0 items-center gap-2 rounded-full ps-2.5 pe-2 text-[13px] outline-none transition-colors hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-accent/60 motion-reduce:transition-none"
        >
          <span aria-hidden="true" className="flex shrink-0 items-center">
            {marks.map((mark, index) => (
              <span
                key={markKey(mark)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full bg-card ring-2 ring-[var(--color-raised)]",
                  index > 0 && "-ms-2",
                  markKey(mark) === newest && "burger-mark-in",
                )}
              >
                <span className="flex scale-[0.8] items-center justify-center"><LayerIcon kind={mark.kind} app={mark.app} /></span>
              </span>
            ))}
          </span>
          <span className={cn("min-w-0 whitespace-pre", tone === "danger" ? "text-danger" : "text-ink")}>{label}</span>
        </button>
        {action}
      </div>
    </div>
  );
}

/** The pill's one action: Add, Add the path, or Undo. */
export const PILL_ACTION =
  "flex h-7 shrink-0 items-center gap-1 rounded-full bg-ink/[0.06] px-3 text-[12px] font-medium text-accent-text outline-none transition-colors hover:bg-ink/[0.1] focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-default disabled:bg-transparent disabled:text-ink-tertiary motion-reduce:transition-none";
