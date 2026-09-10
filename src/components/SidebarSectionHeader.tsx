import { ChevronDown, ChevronRight } from "lucide-react";
import type { DragEvent, KeyboardEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
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
  onOpenMenu,
}: {
  name: string;
  collapsed: boolean;
  attention?: SidebarSectionAttention;
  onToggle?: () => void;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd?: () => void;
  onMove?: (direction: -1 | 1) => void;
  /** the heading's own menu: rename, reorder, remove the label. Takes a point
   * rather than an event, so the keyboard can open it at the row. */
  onOpenMenu?: (point: { x: number; y: number }) => void;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const attentionLabel = attention ? sidebarAttentionLabel(attention) : "";
  const onHeaderKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // The same two keys that open a bot row's menu.
    if (onOpenMenu && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      onOpenMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      return;
    }
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
    <div
      className={cn("flex items-center gap-1 px-2 pb-1", dragging && "opacity-40")}
      data-section={name}
      draggable={reorderable}
      onDragStart={reorderable ? onDragStart : undefined}
      onDragEnd={reorderable ? onDragEnd : undefined}
      onContextMenu={
        onOpenMenu
          ? (event) => {
              event.preventDefault();
              onOpenMenu({ x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={onHeaderKeyDown}
          aria-expanded={!collapsed}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={
            reorderable
              ? collapsed
                ? t("sidebar.section.expandReorder", { name })
                : t("sidebar.section.collapseReorder", { name })
              : collapsed
                ? t("sidebar.section.expand", { name })
                : t("sidebar.section.collapse", { name })
          }
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
        >
          <span className="truncate text-[12px] font-semibold text-ink-secondary">
            {name}
          </span>
          <Chevron size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
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
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <span className="truncate text-[12px] font-semibold text-ink-secondary">
            {name}
          </span>
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </div>
      )}
    </div>
  );
}
