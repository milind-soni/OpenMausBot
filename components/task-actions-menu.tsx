"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Link2, RotateCcw, Search, Tag, Trash2, UserRound } from "lucide-react";
import { ESTIMATES, estimateLabel } from "@/lib/estimates";
import { EstimateIcon } from "./issue-icons";
import { displayName, formatDue } from "@/lib/format";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { UserAvatar } from "./user-avatar";
import { SHEET_CLASS, isSheetLayout } from "./use-anchored-popover";

export type TaskMenuView = "root" | "status" | "priority" | "assignee" | "estimate";
/** Viewport box the menu opens from: a card, a chip, or the pointer (a zero-size box). */
export type TaskMenuAnchor = { left: number; top: number; right: number; bottom: number };
export type TaskMenuPerson = { email: string; name?: string; username?: string; avatarUrl?: string | null };
type Priority = "low" | "medium" | "high";

const PRIORITIES: { value: Priority; label: string }[] = [{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }];
const SUBMENUS: { view: Exclude<TaskMenuView, "root">; label: string }[] = [{ view: "status", label: "Status" }, { view: "priority", label: "Priority" }, { view: "assignee", label: "Assignee" }, { view: "estimate", label: "Estimate" }];
const noAssignee = <span className="task-menu-no-assignee" aria-hidden="true"><UserRound size={12} /></span>;
const items = (menu: HTMLElement | null) => Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
const sheetLayout = isSheetLayout;
const coarsePointer = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/**
 * The invisible layer behind a menu: pressing it closes the menu and nothing underneath gets the press. A mouse closes
 * on press; a tap closes on its click, so the click the browser makes after a tap lands here and not on the card below.
 */
export function MenuScrim({ onClose }: { onClose: () => void }) {
  const tap = useRef(false);
  return <div className="task-menu-scrim" onPointerDown={event => {
    event.preventDefault();
    tap.current = event.pointerType !== "mouse";
    if (!tap.current) onClose();
  }} onClick={() => { if (tap.current) onClose(); }} />;
}

/**
 * The issue card menu: right-click / long-press / ⋯ open it at the root; the card's priority and assignee chips open a
 * submenu directly. On phones it is a bottom sheet. A completed issue (`onReopen`) gets Reopen, Copy link and Delete.
 */
export function TaskMenu({ title, view: initialView, anchor, status, statuses, priority, assignee, members, currentEmail, dueDate, estimate, labelCount = 0, onStatus, onPriority, onAssignee, onDueDate, onEstimate, onLabels, onCopyLink, onDelete, onReopen, onClose }: {
  title: string; view: TaskMenuView; anchor: TaskMenuAnchor;
  status: string; statuses: { id: string; title: string }[];
  priority: string; assignee?: string; members: TaskMenuPerson[]; currentEmail?: string; dueDate?: string;
  onStatus: (columnId: string) => void; onPriority: (priority: Priority) => void; onAssignee: (email: string) => void;
  onDueDate: () => void; onCopyLink: () => void; onDelete: () => void;
  /** Points, or undefined for no estimate; `onEstimate(null)` removes it. */
  estimate?: number; onEstimate?: (value: number | null) => void;
  /** Opens the label picker on the issue (after the menu closes). */
  labelCount?: number; onLabels?: () => void;
  /** The issue is completed: the menu offers Reopen in place of the property submenus. */
  onReopen?: () => void;
  /** `restoreFocus` is false when the menu closes because the pointer went elsewhere. */
  onClose: (restoreFocus: boolean) => void;
}) {
  const [view, setView] = useState<TaskMenuView>(initialView);
  const [query, setQuery] = useState("");
  const [sheet] = useState(sheetLayout);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const nested = initialView === "root";
  const statusTitle = statuses.find(item => item.id === status)?.title ?? "";
  const person = members.find(member => member.email === assignee);
  const due = formatDue(dueDate);
  const people = members.filter(member => `${displayName(member)} ${member.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const showSearch = view === "assignee" && members.length > 6;

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    if (!sheet) {
      const width = element.offsetWidth, height = element.offsetHeight;
      const below = anchor.bottom + 4 + height <= window.innerHeight - 8;
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      const top = below ? anchor.bottom + 4 : Math.max(8, anchor.top - height - 4);
      Object.assign(element.style, { left: `${left}px`, top: `${top}px` });
    }
    if (showSearch && !coarsePointer()) { search.current?.focus({ preventScroll: true }); return; }
    const all = items(element);
    (all.find(item => item.getAttribute("aria-checked") === "true") ?? all[0])?.focus({ preventScroll: true });
    // Only the view decides what gets focus; re-running on every keystroke in the search would steal it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, sheet]);

  const close = (restoreFocus = true) => onClose(restoreFocus);
  const pick = (run: () => void) => { run(); close(); };
  const open = (next: TaskMenuView) => { setQuery(""); setView(next); };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const all = items(menu.current);
    const index = all.indexOf(document.activeElement as HTMLElement);
    const move = (next: number) => { event.preventDefault(); all[(next + all.length) % all.length]?.focus({ preventScroll: true }); };
    if (event.key === "Escape") { event.preventDefault(); if (view !== "root" && nested) open("root"); else close(); }
    else if (event.key === "Tab") { event.preventDefault(); close(); }
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index < 0 ? all.length - 1 : index - 1);
    else if (event.key === "Home" && document.activeElement !== search.current) move(0);
    else if (event.key === "End" && document.activeElement !== search.current) move(all.length - 1);
    else if (event.key === "ArrowRight" && document.activeElement instanceof HTMLElement && document.activeElement.dataset.view) { event.preventDefault(); open(document.activeElement.dataset.view as TaskMenuView); }
    else if (event.key === "ArrowLeft" && view !== "root" && nested && document.activeElement !== search.current) { event.preventDefault(); open("root"); }
  };

  const option = (key: string, checked: boolean, icon: ReactNode, label: ReactNode, run: () => void, extra?: ReactNode) =>
    <button key={key} type="button" role="menuitemradio" aria-checked={checked} onClick={() => pick(run)}>{icon}<span>{label}</span>{extra}{checked && <Check size={14} className="task-menu-check" />}</button>;

  let body: ReactNode;
  if (view === "root" && onReopen) {
    body = <>
      <button type="button" role="menuitem" onClick={() => pick(onReopen)}><RotateCcw size={14} /><span>Reopen</span></button>
      <button type="button" role="menuitem" onClick={() => pick(onCopyLink)}><Link2 size={14} /><span>Copy link</span></button>
      <hr />
      <button type="button" role="menuitem" className="danger-text" onClick={() => pick(onDelete)}><Trash2 size={14} /><span>Delete issue</span></button>
    </>;
  } else if (view === "root") {
    const values: Record<Exclude<TaskMenuView, "root">, { icon: ReactNode; value: string }> = {
      status: { icon: <StatusIcon title={statusTitle} />, value: statusTitle },
      priority: { icon: <PriorityIcon priority={priority} />, value: PRIORITIES.find(item => item.value === priority)?.label ?? "" },
      assignee: { icon: person ? <UserAvatar user={person} /> : noAssignee, value: person ? displayName(person) : "Unassigned" },
      estimate: { icon: <EstimateIcon />, value: estimate ? estimateLabel(estimate) : "None" },
    };
    body = <>
      {SUBMENUS.filter(item => item.view !== "estimate" || onEstimate).map(item => <button key={item.view} type="button" role="menuitem" aria-haspopup="menu" data-view={item.view} onClick={() => open(item.view)}>
        {values[item.view].icon}<span>{item.label}</span><small>{values[item.view].value}</small><ChevronRight size={14} className="task-menu-chevron" />
      </button>)}
      {onLabels && <button type="button" role="menuitem" aria-haspopup="listbox" onClick={() => pick(onLabels)}><Tag size={14} /><span>Labels</span><small>{labelCount ? labelCount : ""}</small></button>}
      <button type="button" role="menuitem" onClick={() => pick(onDueDate)}><CalendarDays size={14} /><span>Due date</span><small className={due?.tone === "overdue" ? "overdue" : undefined}>{due?.label ?? ""}</small></button>
      <hr />
      <button type="button" role="menuitem" onClick={() => pick(onCopyLink)}><Link2 size={14} /><span>Copy link</span></button>
      <hr />
      <button type="button" role="menuitem" className="danger-text" onClick={() => pick(onDelete)}><Trash2 size={14} /><span>Delete issue</span></button>
    </>;
  } else {
    const label = SUBMENUS.find(item => item.view === view)!.label;
    body = <>
      {nested
        ? <button type="button" className="task-menu-back" aria-label={`Back from ${label.toLowerCase()}`} onClick={() => open("root")}><ChevronLeft size={14} /><span>{label}</span></button>
        : <span className="dropdown-caption">{label}</span>}
      {showSearch && <div className="task-menu-search"><Search size={14} /><input ref={search} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" aria-label="Search members" onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); const first = people[0]; if (first) pick(() => onAssignee(first.email)); }
      }} /></div>}
      {view === "status" && statuses.map(item => option(item.id, item.id === status, <StatusIcon title={item.title} />, item.title, () => onStatus(item.id)))}
      {view === "priority" && PRIORITIES.map(item => option(item.value, item.value === priority, <PriorityIcon priority={item.value} />, item.label, () => onPriority(item.value)))}
      {view === "assignee" && !query.trim() && option("unassigned", !assignee, noAssignee, "Unassigned", () => onAssignee(""))}
      {view === "assignee" && people.map(member => option(member.email, member.email === assignee, <UserAvatar user={member} />, displayName(member), () => onAssignee(member.email), member.email === currentEmail ? <small>You</small> : null))}
      {view === "assignee" && !people.length && <p className="task-menu-empty">No members found</p>}
      {view === "estimate" && onEstimate && option("none", !estimate, <EstimateIcon empty />, "No estimate", () => onEstimate(null))}
      {view === "estimate" && onEstimate && ESTIMATES.map(value => option(String(value), value === estimate, <EstimateIcon />, estimateLabel(value), () => onEstimate(value)))}
    </>;
  }

  return createPortal(<div className={`task-menu-layer ${sheet ? "is-sheet" : ""}`} onContextMenu={event => { event.preventDefault(); close(false); }}>
    <MenuScrim onClose={() => close(false)} />
    <div ref={menu} role="menu" aria-label={`Options for ${title}`} className={`origin-dropdown task-menu ${sheet ? SHEET_CLASS : ""}`} onKeyDown={onKeyDown}>
      {sheet && <div className="task-menu-title">{title}</div>}
      {body}
    </div>
  </div>, document.body);
}
