import { ChevronDown, ChevronRight, GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import type { DragEvent, KeyboardEvent, MouseEvent } from "react";

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
  alert,
  onToggle,
  reorderable,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
  onDelete,
  onContextMenu,
  line = false,
  onMenu,
  menuOpen = false,
  lead,
}: {
  name: string;
  collapsed: boolean;
  attention?: SidebarSectionAttention;
  alert?: boolean;
  onToggle?: () => void;
  reorderable: boolean;
  dragging: boolean;
  onDragStart?: (event: DragEvent<HTMLElement>) => void;
  onDragEnd?: () => void;
  onMove?: (direction: -1 | 1) => void;
  onDelete?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  line?: boolean;
  onMenu?: (button: HTMLButtonElement) => void;
  menuOpen?: boolean;
  /** On a Team Cloud, the person every bot in this department reports to. */
  lead?: string;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const leadLabel = lead ? <span data-department-lead={lead} title={t("owner.departmentLeadAria", { department: name, name: lead })}
    className="shrink-0 truncate text-[11px] font-normal text-ink-tertiary">{t("owner.departmentLead", { name: lead })}<span className="sr-only">{`, ${t("owner.departmentLeadAria", { department: name, name: lead })}`}</span></span> : null;
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
  const toggleTitle = reorderable
    ? collapsed
      ? t("sidebar.section.expandReorder", { name })
      : t("sidebar.section.collapseReorder", { name })
    : collapsed
      ? t("sidebar.section.expand", { name })
      : t("sidebar.section.collapse", { name });

  if (line) {
    return (
      <div
        data-section={name}
        data-sidebar-section-line=""
        tabIndex={onContextMenu ? -1 : undefined}
        onContextMenu={onContextMenu}
        draggable={reorderable || undefined}
        onDragStart={reorderable ? onDragStart : undefined}
        onDragEnd={reorderable ? onDragEnd : undefined}
        className={cn("flex items-center gap-2 pb-1.5 pl-1.5 pr-0.5 pt-3.5", reorderable && "cursor-grab", dragging && "opacity-40")}
      >
        {onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            onKeyDown={onHeaderKeyDown}
            aria-expanded={!collapsed}
            aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
            title={toggleTitle}
            className="flex min-w-0 shrink items-center gap-1 rounded px-0.5 text-left text-[12px] font-medium tracking-[0.01em] text-ink-tertiary hover:text-ink-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="truncate">{name}</span>
            {collapsed && <ChevronRight size={11} className="shrink-0" aria-hidden="true" />}
            <SectionAttention attention={attention} label={attentionLabel} alert={alert} />
          </button>
        ) : (
          <div className="flex min-w-0 shrink items-center px-0.5 text-[12px] font-medium tracking-[0.01em] text-ink-tertiary">
            <span className="truncate">{name}</span>
            {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
          </div>
        )}
        <span aria-hidden="true" className="h-px min-w-4 flex-1 bg-hairline/60" />
        {leadLabel}
        {onMenu && (
          <button
            type="button"
            aria-label={t("team.actions", { name })}
            title={t("team.actions", { name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => onMenu(event.currentTarget)}
            className="flex h-[18px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-ink-tertiary hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus aria-expanded:bg-raised aria-expanded:text-ink"
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2 pb-1" data-section={name} tabIndex={onContextMenu ? -1 : undefined} onContextMenu={onContextMenu}>
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          onKeyDown={onHeaderKeyDown}
          aria-expanded={!collapsed}
          aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
          title={toggleTitle}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-0.5 text-left hover:bg-raised/50"
        >
          <span className="truncate text-[12px] font-semibold text-ink-secondary">
            {name}
          </span>
          <Chevron size={13} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <SectionAttention attention={attention} label={attentionLabel} alert={alert} />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <span className="truncate text-[12px] font-semibold text-ink-secondary">
            {name}
          </span>
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </div>
      )}
      {leadLabel}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={t("sidebar.section.deleteAria", { name })}
          title={t("sidebar.section.deleteAria", { name })}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      )}
      {reorderable && (
        <span
          aria-hidden="true"
          draggable
          title={t("sidebar.section.dragToReorder")}
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

function SectionAttention({ attention, label, alert }: { attention?: SidebarSectionAttention; label: string; alert?: boolean }) {
  return (
    <>
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
      {label && <span className="sr-only">{label}</span>}
      {alert && (
        <>
          <span data-testid="section-alert" aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />
          <span className="sr-only">{t("computer.routines.needsYou")}</span>
        </>
      )}
    </>
  );
}
