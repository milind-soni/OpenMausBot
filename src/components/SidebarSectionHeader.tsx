import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import {
  sidebarAttentionLabel,
  type SidebarSectionAttention,
} from "@/lib/sidebar-attention";

export function SidebarSectionHeader({
  name,
  collapsed,
  attention,
  onToggle,
  reorderable,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  name: string;
  collapsed: boolean;
  attention?: SidebarSectionAttention;
  onToggle?: () => void;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd?: () => void;
  onMove?: (direction: -1 | 1) => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const attentionLabel = attention ? sidebarAttentionLabel(attention) : "";
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!reorderable || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      onMove?.(-1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onMove?.(1);
    }
  };

  return (
    <div className="flex items-center gap-1 px-2 pb-1" data-section={name}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={onHeaderKeyDown}
          aria-expanded={!collapsed}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={
            reorderable
              ? `${collapsed ? "Expand" : "Collapse"} ${name}. Alt+Up/Down reorders it.`
              : `${collapsed ? "Expand" : "Collapse"} ${name}`
          }
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
        >
          <Chevron size={12} className="shrink-0 text-ink-secondary" />
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          {attention && attention.waiting > 0 && (
            <span
              aria-hidden="true"
              className="min-w-4 rounded-full bg-warning/15 px-1 text-center text-[9px] font-semibold leading-4 text-warning"
            >
              {attention.waiting}
            </span>
          )}
          {attention && attention.unread > 0 && (
            <span
              aria-hidden="true"
              className="min-w-4 rounded-full bg-accent/15 px-1 text-center text-[9px] font-semibold leading-4 text-accent"
            >
              {attention.unread}
            </span>
          )}
          {attention && attention.working > 0 && (
            <span
              aria-hidden="true"
              className="flex size-4 items-center justify-center"
            >
              <span className="size-1.5 animate-pulse rounded-full bg-success" />
            </span>
          )}
          <span className="h-px flex-1 bg-hairline/40" />
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
            {name}
          </span>
          <span className="h-px flex-1 bg-hairline/40" />
        </div>
      )}
      {reorderable && (
        <span
          aria-hidden="true"
          draggable
          title="Drag to reorder"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          className={cn(
            "flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink",
            dragging && "opacity-40",
          )}
        >
          <GripVertical size={13} />
        </span>
      )}
    </div>
  );
}
