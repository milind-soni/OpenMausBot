import { ChevronDown, ChevronRight, GripVertical, MoreHorizontal, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import {
  sidebarAttentionLabel,
  type SidebarSectionAttention,
} from "@/lib/sidebar-attention";
import type { SectionNaming } from "./SidebarBotDrag";

export function SidebarSectionHeader({
  name,
  collapsed,
  attention,
  alert,
  onToggle,
  reorderable: canReorder,
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
  count,
  naming,
  dropInto = false,
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
  /** How many rows the section holds, shown at rest where the chevron shows on hover (Simple). */
  count?: number;
  /** A name field in place of the name, for a department being made or renamed. */
  naming?: SectionNaming;
  /** A dragged bot would go into this department. */
  dropInto?: boolean;
}) {
  const reorderable = canReorder && !naming;
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

  const dropMark = dropInto ? "bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70" : undefined;

  if (line) {
    const tail = (
      <span aria-hidden="true" className="relative flex size-4 shrink-0 items-center justify-center">
        {count !== undefined && <span className={cn("text-[12px] tabular-nums leading-4 text-ink-secondary transition-opacity", onToggle && "group-hover/section:opacity-0 group-focus-within/section:opacity-0 touch:opacity-0")}>{count}</span>}
        {onToggle && <Chevron size={14} className="absolute text-ink-secondary opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 touch:opacity-100" />}
      </span>
    );
    return (
      <div
        data-section={name}
        data-sidebar-section-line=""
        data-section-drop={dropInto ? "" : undefined}
        tabIndex={onContextMenu ? -1 : undefined}
        onContextMenu={naming ? undefined : onContextMenu}
        draggable={reorderable || undefined}
        onDragStart={reorderable ? onDragStart : undefined}
        onDragEnd={reorderable ? onDragEnd : undefined}
        className={cn("group/section flex h-[30px] items-center gap-1.5 rounded-[6px] px-2 pb-1.5 pt-2 hover:bg-raised/50", reorderable && "cursor-grab", dragging && "opacity-40", naming && "py-0.5", dropMark)}
      >
        {naming ? <SectionNameField {...naming} /> : onToggle ? (
          <button
            type="button"
            onClick={onToggle}
            onKeyDown={onHeaderKeyDown}
            aria-expanded={!collapsed}
            aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
            title={toggleTitle}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-secondary">{name}</span>
            {leadLabel}
            {collapsed && <SectionAttention attention={attention} label={attentionLabel} alert={alert} />}
            {tail}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-ink-secondary">{name}</span>
            {leadLabel}
            {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
            {tail}
          </div>
        )}
        {onMenu && !naming && (
          <button
            type="button"
            aria-label={t("team.actions", { name })}
            title={t("team.actions", { name })}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => onMenu(event.currentTarget)}
            className="flex h-[18px] w-[22px] shrink-0 items-center justify-center rounded-[5px] text-ink-tertiary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus group-hover/section:opacity-100 group-focus-within/section:opacity-100 aria-expanded:bg-raised aria-expanded:text-ink aria-expanded:opacity-100 touch:opacity-100"
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-1 rounded-md px-2 pb-1", dropMark)} data-section={name} data-section-drop={dropInto ? "" : undefined} tabIndex={onContextMenu ? -1 : undefined} onContextMenu={naming ? undefined : onContextMenu}>
      {naming ? <SectionNameField {...naming} /> : onToggle ? (
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
      {onDelete && !naming && (
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

function SectionNameField({ value, label, onCommit, onCancel }: SectionNaming) {
  const [draft, setDraft] = useState(value);
  const field = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  // A menu that just closed hands focus back to its opener after this field mounts.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);
  const settle = (save: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (save) onCommit(draft);
    else onCancel();
  };
  return (
    <input
      ref={field}
      data-section-name-field=""
      value={draft}
      maxLength={60}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => settle(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          settle(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          settle(false);
        }
      }}
      className="h-6 min-w-0 flex-1 rounded-md bg-ink/[0.05] px-1.5 text-[13px] leading-[18px] text-ink outline-none ring-1 ring-accent/60"
    />
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
