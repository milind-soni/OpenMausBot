"use client";
import { useRef, useState, type CSSProperties } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { taskKey } from "@/lib/project-issues";
import { PriorityIcon, StatusIcon } from "./issue-icons";
import { UserAvatar } from "./user-avatar";

/** The issue page's sub-issue list: progress, one row per child, and an inline "Add sub-issue" field. */
export function SubIssues({ sessionToken, taskId, canEdit, onOpen }: { sessionToken: string; taskId: Id<"tasks">; canEdit: boolean; onOpen: (projectId: Id<"projects">, taskId: Id<"tasks">) => void }) {
  const rows = useQuery(api.issueRoutes.subIssues, { sessionToken, taskId });
  const create = useMutation(api.issueRoutes.createSubIssue);
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const addButton = useRef<HTMLButtonElement>(null);
  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true); setError("");
    try { await create({ sessionToken, parentTaskId: taskId, title: title.trim() }); setTitle(""); }
    catch (cause) { setError(errorText(cause, "Could not add sub-issue")); }
    finally { setBusy(false); }
  };
  const stopAdding = () => { setAdding(false); setTitle(""); requestAnimationFrame(() => addButton.current?.focus({ preventScroll: true })); };
  if (!rows) return null;
  if (!rows.length && !canEdit) return null;
  const done = rows.filter(row => row.done).length;
  return <section className="sub-issues" aria-label="Sub-issues">
    {rows.length > 0 ? <header className="sub-issues-head">
      <button type="button" className="sub-issues-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>Sub-issues</span></button>
      <span className="sub-issues-progress" aria-label={`${done} of ${rows.length} done`}><span className="sub-issues-ring" style={{ "--progress": `${Math.round((done / rows.length) * 100)}%` } as CSSProperties} />{done}/{rows.length}</span>
      {canEdit && <button type="button" className="icon-button" aria-label="Add sub-issue" title="Add sub-issue" onClick={() => { setOpen(true); setAdding(true); }}><Plus size={14} /></button>}
    </header> : !adding && canEdit && <button ref={addButton} type="button" className="issue-add-row" onClick={() => setAdding(true)}><Plus size={14} />Add sub-issues</button>}
    {open && rows.length > 0 && <ul className="sub-issue-list">{rows.map(row => <li key={row._id}>
      <button type="button" className="sub-issue-row" onClick={() => onOpen(row.projectId, row._id)}>
        <PriorityIcon priority={row.priority} />
        {row.done ? <CheckCircle2 size={14} className="sub-issue-done" aria-label="Done" /> : <StatusIcon title={row.status ?? "Todo"} />}
        <small className="issue-key">{taskKey(row._id)}</small>
        <span className={row.done ? "is-done" : undefined}>{row.title}</span>
        {row.assignedToEmail && <UserAvatar user={{ email: row.assignedToEmail, name: row.assignedToName }} size="small" />}
      </button>
    </li>)}</ul>}
    {adding && <form className="sub-issue-add" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {busy ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
      <input autoFocus aria-label="Sub-issue title" placeholder="Sub-issue title" maxLength={250} value={title} readOnly={busy} onChange={event => setTitle(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopAdding(); } }}
        onBlur={() => { if (!title.trim() && !busy) setAdding(false); }} />
      <button type="submit" className="ghost-button compact" disabled={!title.trim() || busy}>Add</button>
    </form>}
    {error && <p className="issue-field-error" role="alert">{error}</p>}
  </section>;
}
