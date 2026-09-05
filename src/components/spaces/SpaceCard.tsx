import { Component, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";

import type { Bot, Group } from "@/state/store";
import { BotAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { statusChip, TONE_CLASS } from "./spaces-status";

/** One broken bot shows a failed tile, not a dead canvas. */
class CardBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-ink-secondary">
          {this.props.name} could not be shown here. Open it from the sidebar to see what happened.
        </div>
      );
    }
    return this.props.children;
  }
}

function isGroup(subject: Bot | Group): subject is Group {
  return Array.isArray((subject as Group).memberIds);
}

export interface SpaceCardProps {
  subject: Bot | Group;
  focused: boolean;
  onFocus: () => void;
  /** Beyond the performance budget: keep the card in place, drop its body. */
  parked?: boolean;
  /** Lift this card's browser out into a full-screen surface. Focused-only. */
  onExpand?: () => void;
  children: ReactNode;
}

export function SpaceCard({ subject, focused, onFocus, parked = false, onExpand, children }: SpaceCardProps) {
  const chip = statusChip(subject);
  const room = isGroup(subject);
  const subtitle = room
    ? `${subject.memberIds.length} member${subject.memberIds.length === 1 ? "" : "s"}`
    : subject.title || subject.description || "";

  return (
    <section
      aria-label={subject.name}
      {...(focused ? { "aria-current": "true" as const } : {})}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-panel shadow-2xl transition-[border-color,opacity] duration-200",
        focused ? "border-accent/40 opacity-100" : "border-hairline/40 opacity-80",
      )}
    >
      {/* The whole header is the hit target: clicking a card focuses it,
          which is also how the grid behaves. */}
      <button
        type="button"
        onClick={onFocus}
        className="flex shrink-0 items-center gap-2.5 border-b border-hairline/30 px-3 py-2.5 text-left"
      >
        {room ? (
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-medium text-ink-secondary">
            {subject.memberIds.length}
          </span>
        ) : (
          <BotAvatar bot={subject} size={28} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{subject.name}</span>
          {subtitle ? (
            <span className="block truncate text-[11px] text-ink-secondary">{subtitle}</span>
          ) : null}
        </span>
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
            TONE_CLASS[chip.tone],
          )}
        >
          {chip.label}
        </span>
      </button>
      {onExpand ? (
        <button
          type="button"
          aria-label={`Expand ${subject.name}`}
          onClick={onExpand}
          className="absolute right-2 top-11 z-10 grid size-7 place-items-center rounded-full border border-hairline/40 bg-panel/90 text-ink-secondary backdrop-blur hover:text-ink"
        >
          <Maximize2 size={13} />
        </button>
      ) : null}

      <div className="relative min-h-0 flex-1">
        {parked ? (
          <div className="flex h-full items-center justify-center text-[12px] text-ink-secondary">
            Paused to keep the canvas smooth — click to open.
          </div>
        ) : (
          <CardBoundary name={subject.name}>{children}</CardBoundary>
        )}
      </div>
    </section>
  );
}
