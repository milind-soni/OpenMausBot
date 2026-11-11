"use client";

import { memo, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import clsx from "clsx";
import { CalendarDays, Check, MoreHorizontal, UserRound } from "lucide-react";
import type { Doc } from "@/convex/_generated/dataModel";
import { displayName, formatDue } from "@/lib/format";
import { taskKey } from "@/lib/project-issues";
import { GitHubIssueIndicator, type LinkedPullRequest } from "./github-issue-indicator";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { UserAvatar } from "./user-avatar";
import type { TaskMenuAnchor, TaskMenuView } from "./task-actions-menu";

type Task = Doc<"tasks">;
export type CardPerson = { email: string; name?: string; username?: string; avatarUrl?: string | null };
const PRIORITY_LABEL: Record<string, string> = { high: "High", medium: "Medium", low: "Low" };
type OnMenu = (task: Task, view: TaskMenuView, anchor: TaskMenuAnchor, from: HTMLElement) => void;
type OnDueDate = (task: Task, from: HTMLElement) => void;

/** What a board card and a list row share: the same issue, the same quick edits, the same menu. */
type IssueItemProps = {
  task: Task;
  assignee: CardPerson | null;
  canEdit: boolean;
  tabStop: boolean;
  selected: boolean;
  completing?: "checked";
  menuOpen: boolean;
  onOpen: (taskId: Task["_id"]) => void;
  onComplete: (task: Task) => void;
  onMenu: OnMenu;
  /** Opens the due date popover anchored to the clicked chip. */
  onDueDate: OnDueDate;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, task: Task) => void;
  onFocus: (taskId: string) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, taskId: string) => void;
};

export type IssueCardProps = IssueItemProps & {
  /** The pull request linked to the issue, if any (from the board query). */
  pullRequest?: LinkedPullRequest;
  dragState?: "placeholder" | "moving";
  keyboardMoving: boolean;
  onHandleKeyDown: (event: ReactKeyboardEvent<HTMLElement>, taskId: string) => void;
  onHandleClick: (event: ReactMouseEvent<HTMLElement>, taskId: string) => void;
  onHandleBlur: (taskId: string) => void;
};

/**
 * Chrome on phones moves a tap to the nearest element that listens for clicks. React listens at the root, so without
 * a listener of their own the title and key lose taps near them to the chips; this makes them count as tap targets.
 */
const noop = () => {};
const tapTarget = (element: HTMLElement | null) => {
  element?.addEventListener("click", noop);
  return () => element?.removeEventListener("click", noop);
};

const box = (element: Element): TaskMenuAnchor => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; };
const openChip = (task: Task, view: TaskMenuView, onMenu: OnMenu) => (event: ReactMouseEvent<HTMLButtonElement>) => { event.stopPropagation(); onMenu(task, view, box(event.currentTarget), event.currentTarget); };
const pointAt = (event: ReactMouseEvent): TaskMenuAnchor => ({ left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY });

/**
 * The complete control on every issue surface: a rounded square (status icons are rings), a green tick once done.
 * With `reopen`, a done issue's tick stays pressable and calls `onComplete` again to reopen it (Inbox, profiles), and
 * the control is its own Tab stop (those rows have no card menu to reach it from).
 */
export function CompleteCheck<T extends { title: string }>({ task, done, canEdit, onComplete, reopen = false, className }: { task: T; done: boolean; canEdit: boolean; onComplete: (task: T) => void; reopen?: boolean; className?: string }) {
  return <button className={clsx("check-button", className)} type="button" tabIndex={reopen ? undefined : -1} aria-label={done ? `${reopen ? "Reopen" : "Completed"} ${task.title}` : `Complete ${task.title}`} disabled={!canEdit || (done && !reopen)} onClick={event => { event.stopPropagation(); onComplete(task); }}>
    {done ? <span className="check-done"><Check size={10} strokeWidth={3} /></span> : <span className="check-box" />}
  </button>;
}

export function StatusChip({ task, title, label, canEdit, onMenu }: { task: Task; title: string; label: string; canEdit: boolean; onMenu: OnMenu }) {
  const content = <><StatusIcon title={title} /><span>{label}</span></>;
  return canEdit
    ? <button type="button" tabIndex={-1} className="task-chip status-chip" aria-label={`Status: ${label}`} aria-haspopup="menu" onClick={openChip(task, "status", onMenu)}>{content}</button>
    : <span className="task-chip status-chip">{content}</span>;
}

export function PriorityChip({ task, canEdit, onMenu }: { task: Task; canEdit: boolean; onMenu: OnMenu }) {
  const label = PRIORITY_LABEL[task.priority] ?? task.priority;
  return canEdit
    ? <button type="button" tabIndex={-1} className={clsx("task-chip priority", task.priority)} aria-label={`Priority: ${label}`} aria-haspopup="menu" onClick={openChip(task, "priority", onMenu)}><PriorityIcon priority={task.priority} /><span>{label}</span></button>
    : <span className={clsx("task-chip priority", task.priority)}><PriorityIcon priority={task.priority} /><span>{label}</span></span>;
}

/** Due date chip; `empty` shows a quiet date button when there is no due date (list rows). */
export function DueChip({ task, canEdit, onDueDate, empty = false }: { task: Task; canEdit: boolean; onDueDate: OnDueDate; empty?: boolean }) {
  const due = formatDue(task.dueDate);
  if (!due && !(empty && canEdit)) return null;
  // A completed issue is never overdue.
  const tone = due && !task.done ? due.tone : undefined;
  if (!canEdit) return <span className={clsx("task-chip due-chip", tone)}><CalendarDays size={12} /><span>{due!.label}</span></span>;
  return <button type="button" tabIndex={-1} className={clsx("task-chip due-chip", due ? tone : "is-empty")} aria-label={`Due date: ${due ? due.label : "No due date"}`} aria-haspopup="dialog" onClick={event => { event.stopPropagation(); onDueDate(task, event.currentTarget); }}>
    <CalendarDays size={12} />{due && <span>{due.label}</span>}
  </button>;
}

/** Assignee avatar (with the name in list rows) that opens the assignee menu. */
export function AssigneeChip({ task, assignee, canEdit, onMenu, withName = false }: { task: Task; assignee: CardPerson | null; canEdit: boolean; onMenu: OnMenu; withName?: boolean }) {
  const name = assignee ? displayName(assignee) : "";
  const face = assignee ? <UserAvatar user={assignee} /> : <span className="task-assignee-empty"><UserRound size={12} /></span>;
  const label = withName && assignee ? <span className="task-assignee-name">{name}</span> : null;
  if (canEdit) return <button type="button" tabIndex={-1} className={clsx("task-assignee", !assignee && "is-empty", withName && "with-name")} aria-label={`Assignee: ${assignee ? name : "Unassigned"}`} title={!withName && name ? name : undefined} aria-haspopup="menu" onClick={openChip(task, "assignee", onMenu)}>{face}{label}</button>;
  return assignee ? <span className={clsx("task-assignee", withName && "with-name")} title={!withName ? name : undefined}>{face}{label}</span> : null;
}

/** Up to two labels on a card, then a count; the issue view shows and edits them all. */
function CardLabels({ labels }: { labels?: string[] }) {
  if (!labels?.length) return null;
  const rest = labels.length - 2;
  return <span className="task-labels" aria-label={`Labels: ${labels.join(", ")}`}>
    {labels.slice(0, 2).map(label => <span key={label} className="task-label" aria-hidden="true">{label}</span>)}
    {rest > 0 && <span className="task-label" aria-hidden="true">+{rest}</span>}
  </span>;
}

/**
 * One board card. The card is a single Tab stop that opens the issue; its chips edit priority, due date and assignee in
 * place. Inner controls are pointer targets only (tabIndex -1): keyboard users get the same actions from the menu
 * (Shift+F10 / context-menu key) and the issue view.
 */
export const IssueCard = memo(function IssueCard({ task, pullRequest, assignee, canEdit, tabStop, selected, completing, dragState, keyboardMoving, menuOpen, onOpen, onComplete, onMenu, onDueDate, onKeyDown, onFocus, onPointerDown, onHandleKeyDown, onHandleClick, onHandleBlur }: IssueCardProps) {
  const key = taskKey(task._id);
  const done = task.done || Boolean(completing);
  return (
    <article
      className={clsx("task-card", canEdit && "can-drag", done && "done", selected && "is-selected", menuOpen && "has-menu",
        completing && "is-completing",
        dragState === "placeholder" && "is-placeholder", dragState === "moving" && "is-moving")}
      data-task-id={task._id}
      data-priority={task.priority}
      tabIndex={tabStop ? 0 : -1}
      aria-label={`${key} ${task.title}`}
      aria-current={selected ? "true" : undefined}
      onPointerDown={event => onPointerDown(event, task._id)}
      onDragStart={event => event.preventDefault()}
      onClick={() => onOpen(task._id)}
      onFocus={event => { if (event.target === event.currentTarget) onFocus(task._id); }}
      onKeyDown={event => onKeyDown(event, task)}
      onContextMenu={event => {
        if (!canEdit || (event.target as Element).closest("input")) return;
        event.preventDefault();
        onMenu(task, "root", pointAt(event), event.currentTarget);
      }}
    >
      <div className="task-card-head">
        <span className="task-code issue-key" ref={tapTarget}>{key}<GitHubIssueIndicator number={task.githubIssueNumber} pullRequest={pullRequest} /></span>
        {canEdit && <button className="drag-handle" type="button" tabIndex={-1} aria-label={`Move ${task.title}`} aria-pressed={keyboardMoving} onKeyDown={event => onHandleKeyDown(event, task._id)} onClick={event => onHandleClick(event, task._id)} onBlur={() => onHandleBlur(task._id)} />}
        <AssigneeChip task={task} assignee={assignee} canEdit={canEdit} onMenu={onMenu} />
      </div>
      <div className="task-top">
        <CompleteCheck task={task} done={done} canEdit={canEdit} onComplete={onComplete} />
        <strong ref={tapTarget}>{task.title}</strong>
      </div>
      <div className="task-meta">
        <PriorityChip task={task} canEdit={canEdit} onMenu={onMenu} />
        <DueChip task={task} canEdit={canEdit} onDueDate={onDueDate} />
        <CardLabels labels={task.labels} />
        {canEdit && <button type="button" tabIndex={-1} className="icon-button task-menu-button task-actions" aria-label={`Issue options for ${task.title}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={event => { event.stopPropagation(); onMenu(task, "root", box(event.currentTarget), event.currentTarget); }}><MoreHorizontal size={14} /></button>}
      </div>
    </article>
  );
});

/**
 * One list row: the same Tab stop, keys, menu (right-click, Shift+F10, long-press) and quick-edit chips as a card.
 */
export const IssueRow = memo(function IssueRow({ task, assignee, status, canEdit, tabStop, selected, completing, menuOpen, onOpen, onComplete, onMenu, onDueDate, onKeyDown, onFocus, onPointerDown }: IssueItemProps & { status?: { title: string; label: string } }) {
  const key = taskKey(task._id);
  const done = task.done || Boolean(completing);
  return (
    <tr
      data-task-id={task._id}
      className={clsx(canEdit && "can-press", selected && "is-selected", menuOpen && "has-menu", completing && "is-completing")}
      tabIndex={tabStop ? 0 : -1}
      aria-label={`${key} ${task.title}`}
      aria-current={selected ? "true" : undefined}
      onPointerDown={event => onPointerDown(event, task._id)}
      onClick={() => onOpen(task._id)}
      onFocus={event => { if (event.target === event.currentTarget) onFocus(task._id); }}
      onKeyDown={event => onKeyDown(event, task)}
      onContextMenu={event => {
        if (!canEdit) return;
        event.preventDefault();
        onMenu(task, "root", pointAt(event), event.currentTarget);
      }}
    >
      <td className="col-issue">
        <CompleteCheck task={task} done={done} canEdit={canEdit} onComplete={onComplete} />
        <span className="issue-table-title" ref={tapTarget}><small className="issue-key">{key}</small><span>{task.title}</span></span>
      </td>
      <td className="col-status">{status && <StatusChip task={task} title={status.title} label={status.label} canEdit={canEdit} onMenu={onMenu} />}</td>
      <td className="col-priority"><PriorityChip task={task} canEdit={canEdit} onMenu={onMenu} /></td>
      <td className="col-assignee"><AssigneeChip task={task} assignee={assignee} canEdit={canEdit} onMenu={onMenu} withName /></td>
      <td className="col-due"><DueChip task={task} canEdit={canEdit} onDueDate={onDueDate} empty /></td>
    </tr>
  );
});
