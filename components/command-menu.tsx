"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import clsx from "clsx";
import { CalendarDays, Check, ChevronLeft, CircleDot, Copy, GitBranch, Inbox, Keyboard, LinkIcon, MessageCircle, Search, SquarePen, Tag, UserRound, UserRoundCheck, UserRoundX, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { displayName, formatDue } from "@/lib/format";
import { taskKey } from "@/lib/project-issues";
import { issuePath } from "@/lib/issue-route";
import { taskBranch } from "@/lib/task-branch";
import { dueDatePresets, filterCommands, filterShortcuts, shortcutLabels, suggestLabels, type ShortcutKeys } from "@/lib/command-menu";
import { useModalKeyboard } from "./use-modal-keyboard";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { UserAvatar } from "./user-avatar";
import { LabelList } from "./issue-labels";
import { useWorkspace } from "./workspace-context";
import { showIssueToast } from "./issue-shared";

export type CommandPage = "root" | "status" | "priority" | "assignee" | "labels" | "due-date";
export type CommandIssue = { projectId: Id<"projects">; taskId: Id<"tasks"> };
type Item = { id: string; label: string; icon: ReactNode; group?: string; keywords?: string; shortcut?: ShortcutKeys; checked?: boolean; run: () => unknown };

export function Kbd({ keys }: { keys: ShortcutKeys }) {
  return <span className="shortcut-keys">{shortcutLabels(keys).map((key, index) => key === "then" ? <span key={index} className="shortcut-then">then</span> : <kbd key={index}>{key}</kbd>)}</span>;
}

const PRIORITIES = [{ value: "high", label: "High" }, { value: "medium", label: "Medium" }, { value: "low", label: "Low" }] as const;
const PLACEHOLDER: Record<CommandPage, string> = { root: "Type a command or search…", status: "Change status…", priority: "Change priority…", assignee: "Assign to…", labels: "Change or add labels…", "due-date": "Change due date…" };

/**
 * ⌘K / Ctrl+K: Linear's command menu. With an issue in focus (the issue page, or a focused row or card) it leads with
 * that issue's actions; S, P, L, A and Shift+D open it straight on the matching page. General commands follow.
 */
export function CommandMenu({ sessionToken, issue, canEdit, initialPage = "root", onClose, onCreateIssue, onSearch, onShortcuts, onOpenInbox, onOpenChat, onOpenIssue }: {
  sessionToken: string;
  issue: CommandIssue | null;
  canEdit: boolean;
  initialPage?: CommandPage;
  onClose: () => void;
  onCreateIssue?: () => void;
  onSearch: () => void;
  onShortcuts: () => void;
  onOpenInbox: () => void;
  onOpenChat: () => void;
  onOpenIssue: (projectId: Id<"projects">, taskId: Id<"tasks">) => void;
}) {
  const workspace = useWorkspace();
  const details = useQuery(api.tasks.details, issue ? { ...issue, sessionToken } : "skip");
  const labels = useQuery(api.issueRelations.list, issue ? { sessionToken, taskId: issue.taskId } : "skip");
  const me = useQuery(api.auth.me, { sessionToken });
  const updateTask = useMutation(api.tasks.updateTask);
  const moveTask = useMutation(api.tasks.moveTask);
  const saveLabels = useMutation(api.issueRelations.labels);
  const [page, setPageState] = useState<CommandPage>(issue && canEdit ? initialPage : "root");
  const [query, setQuery] = useState("");
  // Null until the person moves: then the current value of a picker page (or the first item) is highlighted.
  const [active, setActive] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [pendingLabels, setPendingLabels] = useState<string[] | null>(null);
  const modal = useRef<HTMLElement>(null), input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null);
  const id = useId();
  useModalKeyboard(modal, onClose);
  const setPage = (next: CommandPage) => { setPageState(next); setQuery(""); setActive(null); };
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [page]);

  const task = details?.task;
  const editable = Boolean(issue && canEdit && task);
  const key = issue ? taskKey(issue.taskId) : "";
  const run = (action: () => Promise<unknown>, fallback: string) => { onClose(); void action().catch(cause => showIssueToast(errorText(cause, fallback))); };
  const update = (patch: { priority?: "low" | "medium" | "high"; assignedToEmail?: string; dueDate?: string; done?: boolean }) => issue && run(() => updateTask({ ...issue, sessionToken, ...patch }), "Could not update issue");
  const copy = (text: string, done: string) => { onClose(); void navigator.clipboard.writeText(text).then(() => showIssueToast(done), () => showIssueToast("Clipboard unavailable")); };
  const go = (next: CommandPage) => () => { setError(""); setPage(next); };

  const columns = details?.columns.filter(column => !(column.isDone ?? column.title.toLowerCase() === "done")) ?? [];
  let items: Item[] = [];
  if (page === "root") {
    items = [
      ...(issue && editable && task ? [
        { id: "assign", group: "Issue", label: "Assign to…", icon: <UserRound size={15} />, shortcut: ["A"], keywords: "assignee owner", run: go("assignee") },
        ...(me && task.assignedToEmail !== me.email ? [{ id: "assign-me", group: "Issue", label: "Assign to me", icon: <UserRoundCheck size={15} />, shortcut: ["I"], keywords: "self", run: () => update({ assignedToEmail: me.email }) }] : []),
        ...(task.assignedToEmail ? [{ id: "unassign", group: "Issue", label: task.assignedToEmail === me?.email ? "Unassign from me" : "Unassign", icon: <UserRoundX size={15} />, run: () => update({ assignedToEmail: "" }) }] : []),
        { id: "status", group: "Issue", label: "Change status…", icon: <CircleDot size={15} />, shortcut: ["S"], keywords: "state column move done complete", run: go("status") },
        { id: "priority", group: "Issue", label: "Change priority…", icon: <PriorityIcon priority={task.priority} />, shortcut: ["P"], keywords: "urgent high low", run: go("priority") },
        { id: "labels", group: "Issue", label: "Change or add labels…", icon: <Tag size={15} />, shortcut: ["L"], keywords: "tag feature bug improvement", run: go("labels") },
        { id: "due", group: "Issue", label: "Change due date…", icon: <CalendarDays size={15} />, shortcut: ["Shift", "D"], keywords: "deadline date", run: go("due-date") },
      ] : []),
      ...(issue ? [
        { id: "copy-url", group: "Issue", label: "Copy issue URL", icon: <LinkIcon size={15} />, shortcut: ["Mod", "Shift", ","], keywords: "link share", run: () => copy(new URL(issuePath(workspace.slug, issue.taskId), window.location.origin).href, "Link copied") },
        { id: "copy-id", group: "Issue", label: "Copy issue ID", icon: <Copy size={15} />, shortcut: ["Mod", "."], keywords: "key identifier", run: () => copy(key, "Issue ID copied") },
        ...(task ? [{ id: "copy-branch", group: "Issue", label: "Copy git branch name", icon: <GitBranch size={15} />, shortcut: ["Mod", "Shift", "."], keywords: "git github", run: () => copy(taskBranch(task), "Branch name copied") }] : []),
        ...(document.querySelector("[data-issue-page]") ? [] : [{ id: "open", group: "Issue", label: "Open issue", icon: <CircleDot size={15} />, shortcut: ["Enter"], keywords: "page full", run: () => { onClose(); onOpenIssue(issue.projectId, issue.taskId); } }]),
      ] : []),
      ...(onCreateIssue ? [{ id: "create", group: "General", label: "Create new issue", icon: <SquarePen size={15} />, shortcut: ["C"], keywords: "new add", run: () => { onClose(); onCreateIssue(); } }] : []),
      { id: "search", group: "General", label: "Search workspace", icon: <Search size={15} />, shortcut: ["/"], keywords: "find", run: () => { onClose(); onSearch(); } },
      { id: "shortcuts", group: "General", label: "Keyboard shortcuts", icon: <Keyboard size={15} />, shortcut: ["?"], keywords: "help keys", run: () => { onClose(); onShortcuts(); } },
      { id: "inbox", group: "Navigation", label: "Go to inbox", icon: <Inbox size={15} />, keywords: "notifications", run: () => { onClose(); onOpenInbox(); } },
      { id: "chat", group: "Navigation", label: "Go to chat", icon: <MessageCircle size={15} />, keywords: "messages", run: () => { onClose(); onOpenChat(); } },
    ];
  } else if (page === "status" && issue && task) {
    const current = task.done ? "done" : task.columnId;
    items = [
      ...columns.map(column => ({ id: column._id, label: column.title, icon: <StatusIcon title={column.title} />, checked: current === column._id, run: () => run(async () => {
        if (task.done) await updateTask({ ...issue, sessionToken, done: false });
        if (column._id !== task.columnId) await moveTask({ ...issue, sessionToken, columnId: column._id });
      }, "Could not change status") })),
      { id: "done", label: "Done", icon: <StatusIcon title="Done" />, keywords: "complete close", checked: task.done, run: () => update({ done: true }) },
    ];
  } else if (page === "priority" && task) {
    items = PRIORITIES.map(option => ({ id: option.value, label: option.label, icon: <PriorityIcon priority={option.value} />, checked: task.priority === option.value, run: () => update({ priority: option.value }) }));
  } else if (page === "assignee" && task) {
    items = [
      { id: "none", label: "No assignee", icon: <span className="task-menu-no-assignee"><UserRound size={12} /></span>, keywords: "unassign nobody", checked: !task.assignedToEmail, run: () => update({ assignedToEmail: "" }) },
      ...(details?.members ?? []).slice().sort((a, b) => Number(b.email === me?.email) - Number(a.email === me?.email)).map(member => ({
        id: member.email, label: member.email === me?.email ? `${displayName(member)} (you)` : displayName(member), keywords: `${member.email} ${member.username ?? ""}`,
        icon: <UserAvatar user={member} size="small" />, checked: task.assignedToEmail === member.email, run: () => update({ assignedToEmail: member.email }),
      })),
    ];
  } else if (page === "due-date" && task) {
    items = [
      ...dueDatePresets().map(preset => ({ id: preset.value, label: preset.label, keywords: preset.value, icon: <CalendarDays size={15} />, checked: task.dueDate === preset.value, run: () => update({ dueDate: preset.value }) })),
      ...(task.dueDate ? [{ id: "clear", label: "Remove due date", keywords: "clear none", icon: <X size={15} />, run: () => update({ dueDate: "" }) }] : []),
    ];
    // A typed date (YYYY-MM-DD) is offered as its own item.
    const typed = query.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(typed) && !items.some(item => item.id === typed)) items.unshift({ id: typed, label: `Due ${formatDue(typed)?.label ?? typed}`, keywords: typed, icon: <CalendarDays size={15} />, run: () => update({ dueDate: typed }) });
  }

  const matches = filterCommands(items, query);
  const current = Math.min(active ?? (page !== "root" && !query ? Math.max(0, matches.findIndex(item => item.checked)) : 0), Math.max(0, matches.length - 1));

  const back = () => { if (page !== "root" && initialPage === "root") setPage("root"); else onClose(); };
  const labelValue = pendingLabels ?? labels?.labels ?? [];
  const toggleLabel = (name: string) => {
    if (!issue) return;
    const lower = name.toLowerCase();
    const next = labelValue.some(label => label.toLowerCase() === lower) ? labelValue.filter(label => label.toLowerCase() !== lower) : [...labelValue, name];
    setPendingLabels(next); setError("");
    void saveLabels({ sessionToken, taskId: issue.taskId, labels: next }).catch(cause => { setPendingLabels(null); setError(errorText(cause, "Could not update labels")); });
  };

  return <div className="modal-backdrop search-backdrop" onClick={onClose}>
    <section ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Command menu" className="search-modal command-menu" onClick={event => event.stopPropagation()}>
      {issue && <div className="command-menu-context">{page !== "root" && initialPage === "root" && <button type="button" className="icon-button" aria-label="Back" onClick={back}><ChevronLeft size={14} /></button>}<span className="issue-key">{key}</span><span>{task?.title ?? "Loading…"}</span></div>}
      {page === "labels" && issue ? <div className="command-menu-labels" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); back(); } }}>
        <LabelList selected={labelValue} onToggle={toggleLabel} suggestions={task ? suggestLabels(`${task.title} ${task.description ?? ""}`) : []} shortcut="L" onEscape={back} />
      </div> : <>
        <div className="search-input-row"><Search size={16} />
          <input ref={input} data-initial-focus value={query} placeholder={PLACEHOLDER[page]} aria-label={PLACEHOLDER[page]} role="combobox" aria-expanded="true" aria-controls={id} aria-activedescendant={matches[current] ? `${id}-${current}` : undefined} maxLength={120}
            onChange={event => { setQuery(event.target.value); setActive(null); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!matches.length) return;
                const next = (current + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
                setActive(next);
                list.current?.querySelector(`#${CSS.escape(`${id}-${next}`)}`)?.scrollIntoView({ block: "nearest" });
              } else if (event.key === "Enter") { event.preventDefault(); void matches[current]?.run(); }
              else if (event.key === "Escape" && page !== "root") { event.preventDefault(); event.stopPropagation(); back(); }
              else if (event.key === "Backspace" && !query && page !== "root" && initialPage === "root") { event.preventDefault(); setPage("root"); }
            }} />
        </div>
        <div ref={list} className="search-results command-menu-results" id={id} role="listbox" aria-label={PLACEHOLDER[page]}>
          {matches.map((item, index) => <CommandRow key={item.id} id={`${id}-${index}`} item={item} heading={item.group && item.group !== matches[index - 1]?.group ? item.group : undefined} selected={index === current} onHover={() => setActive(index)} />)}
          {!matches.length && <p className="muted">{issue && !task && page !== "root" ? "Loading…" : "No matching commands"}</p>}
        </div>
      </>}
      {error && <p className="issue-field-error command-menu-error" role="alert">{error}</p>}
    </section>
  </div>;
}

function CommandRow({ id, item, heading, selected, onHover }: { id: string; item: Item; heading?: string; selected: boolean; onHover: () => void }) {
  return <>
    {heading && <div className="command-menu-heading" role="presentation">{heading}</div>}
    <button id={id} type="button" role="option" tabIndex={-1} aria-selected={selected} className={clsx(item.checked && "is-current")} onMouseMove={onHover} onClick={() => void item.run()}>
      <span className="command-menu-icon">{item.icon}</span>
      <span className="search-result-label">{item.label}</span>
      {item.checked && <Check size={14} className="command-menu-check" aria-label="Current" />}
      {item.shortcut && <Kbd keys={item.shortcut} />}
    </button>
  </>;
}

/** `?`: every shortcut, searchable, in a side sheet like Linear's. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const modal = useRef<HTMLElement>(null);
  useModalKeyboard(modal, onClose);
  const entries = filterShortcuts(query);
  const groups = [...new Set(entries.map(entry => entry.group))];
  return <div className="modal-backdrop shortcuts-backdrop" onClick={onClose}>
    <section ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="shortcuts-sheet" onClick={event => event.stopPropagation()}>
      <header><h2 id="shortcuts-title">Keyboard shortcuts</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button></header>
      <label className="shortcuts-search"><Search size={14} /><input data-initial-focus placeholder="Search shortcuts" aria-label="Search shortcuts" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="shortcuts-list">
        {groups.map(group => <section key={group}><h3>{group}</h3><dl>{entries.filter(entry => entry.group === group).map(entry => <div key={entry.label}><dt>{entry.label}</dt><dd><Kbd keys={entry.keys} /></dd></div>)}</dl></section>)}
        {!entries.length && <p className="muted">No matching shortcuts</p>}
      </div>
    </section>
  </div>;
}
