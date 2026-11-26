import { ChevronDown, ChevronRight, GripVertical, MoreHorizontal, Share2, Trash2 } from "lucide-react";
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
  count,
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
  onShare,
  onContextMenu,
  line = false,
  onMenu,
  reserveMenu = false,
  menuOpen = false,
  naming,
  dropInto = false,
}: {
  name: string;
  /** How many rows the section holds, for a section whose size is the point of it. */
  count?: number;
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
  onShare?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  line?: boolean;
  onMenu?: (button: HTMLButtonElement) => void;
  /** Keep the ⋯ button's space when this line has none, so chevrons line up with lines that do (Simple). */
  reserveMenu?: boolean;
  menuOpen?: boolean;
  /** A name field in place of the name, for a department being made or renamed. */
  naming?: SectionNaming;
  /** A dragged bot would go into this department. */
  dropInto?: boolean;
}) {
  const reorderable = canReorder && !naming;
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
  const toggleTitle = reorderable
    ? collapsed
      ? t("sidebar.section.expandReorder", { name })
      : t("sidebar.section.collapseReorder", { name })
    : collapsed
      ? t("sidebar.section.expand", { name })
      : t("sidebar.section.collapse", { name });

  const counted = count !== undefined;
  const size = counted && <span data-section-count="" className={cn("shrink-0 text-[12px] leading-4 tabular-nums text-ink-tertiary", line && "me-auto")}>{count}</span>;
  const dropMark = dropInto ? "bg-accent/10 outline outline-2 -outline-offset-2 outline-accent/70" : undefined;

  if (line) {
    const tail = onToggle && (
      <Chevron size={12} aria-hidden="true" className="shrink-0 text-ink-secondary opacity-0 transition-opacity group-hover/section:opacity-100 group-focus-within/section:opacity-100 touch:opacity-100" />
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
            <span className={cn("min-w-0 truncate text-[13px] leading-[18px] text-ink-secondary", !counted && "flex-1")}>{name}</span>
            {size}
            {collapsed && <SectionAttention attention={attention} label={attentionLabel} alert={alert} />}
            {tail}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className={cn("min-w-0 truncate text-[13px] leading-[18px] text-ink-secondary", !counted && "flex-1")}>{name}</span>
            {size}
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
            className="flex size-6 shrink-0 items-center justify-center rounded-[6px] text-ink-tertiary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus group-hover/section:opacity-100 group-focus-within/section:opacity-100 aria-expanded:bg-raised aria-expanded:text-ink aria-expanded:opacity-100 touch:opacity-100"
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        )}
        {!onMenu && reserveMenu && !naming && <span aria-hidden="true" className="w-6 shrink-0" />}
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
          <span className="truncate text-[13px] leading-[18px] text-ink-secondary">
            {name}
          </span>
          {size}
          <Chevron size={12} className="shrink-0 text-ink-secondary" aria-hidden="true" />
          <SectionAttention attention={attention} label={attentionLabel} alert={alert} />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-1 py-0.5">
          <span className="truncate text-[13px] leading-[18px] text-ink-secondary">
            {name}
          </span>
          {size}
          {attentionLabel && <span className="sr-only">{attentionLabel}</span>}
        </div>
      )}
      {onShare && !naming && (
        <button
          type="button"
          onClick={onShare}
          aria-label={t("template.shareDepartment", { name })}
          title={t("template.shareDepartment", { name })}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Share2 size={13} aria-hidden="true" />
        </button>
      )}
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

type SectionMark = "waiting" | "unread" | "working";

const SECTION_MARK: Record<SectionMark, string> = {
  waiting: "size-2 bg-warning",
  unread: "size-2 bg-accent",
  working: "size-1.5 animate-pulse bg-success motion-reduce:animate-none",
};

/** Waiting and unread each keep their own dot, so a wait never hides unread rows; working shows only when neither does. */
function sectionMarks(attention: SidebarSectionAttention | undefined): SectionMark[] {
  if (!attention) return [];
  const marks: SectionMark[] = [];
  if (attention.waiting > 0) marks.push("waiting");
  if (attention.unread > 0) marks.push("unread");
  if (marks.length === 0 && attention.working > 0) marks.push("working");
  return marks;
}

/** How many rows inside need the person: unread or waiting on them. */
function needsYouCount(attention: SidebarSectionAttention | undefined): number {
  return attention ? attention.needsYou ?? attention.unread + attention.waiting : 0;
}

function SectionAttention({ attention, label, alert }: { attention?: SidebarSectionAttention; label: string; alert?: boolean }) {
  const marks = alert ? [] : sectionMarks(attention);
  const needs = alert ? 0 : needsYouCount(attention);
  return (
    <>
      {needs > 0 && <span aria-hidden="true" title={label} data-section-needs="" className="shrink-0 text-[12px] leading-4 tabular-nums text-ink-tertiary">{needs}</span>}
      {marks.map((mark) => (
        <span key={mark} aria-hidden="true" title={label} data-section-mark={mark} className="flex size-4 shrink-0 items-center justify-center">
          <span className={cn("rounded-full", SECTION_MARK[mark])} />
        </span>
      ))}
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
