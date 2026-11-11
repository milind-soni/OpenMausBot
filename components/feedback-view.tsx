"use client";
import { errorText } from "@/lib/error-text";
import { formatRelative } from "@/lib/format";
import { isDraftColumn, presentColumns } from "@/lib/origin-columns";

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import clsx from "clsx";
import { ArrowUpRight, Bug, Check, CirclePlus, Copy, Lightbulb, Loader2, MessageSquare, RotateCcw, Settings2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { useWorkspace } from "./workspace-context";
import { Dialog } from "./dialog";
import { DelayedSkeleton } from "./delayed-skeleton";
import { IssueFields } from "./issue-fields";
import { ProjectEmpty } from "./project-empty";

type Portal = FunctionReturnType<typeof api.feedback.portals>[number];
type Entry = FunctionReturnType<typeof api.feedback.list>[number];
type Filter = "open" | "completed" | "all";
const filters: Array<{ value: Filter; label: string }> = [{ value: "open", label: "Open" }, { value: "completed", label: "Completed" }, { value: "all", label: "All" }];
const isOpen = (row: Entry) => row.status === "new" || row.status === "planned";

export function FeedbackView({ sessionToken, projectId, projectName, canEdit, onOpenTask }: { sessionToken: string; projectId: Id<"projects">; projectName: string; canEdit: boolean; onOpenTask: (projectId: Id<"projects">, taskId: Id<"tasks">) => void }) {
  const workspace = useWorkspace();
  const portals = useQuery(api.feedback.portals, { sessionToken, teamId: workspace._id });
  const [filter, setFilter] = useState<Filter>("open");
  const [config, setConfig] = useState(false);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  const portal = portals?.find(p => p.projectId === projectId);
  const rows = useQuery(api.feedback.list, portal ? { sessionToken, teamId: workspace._id, portalId: portal._id } : "skip");
  const dismiss = useMutation(api.feedback.dismiss);
  const admin = ["owner", "admin"].includes(workspace.role);
  const visible = rows?.filter(row => filter === "all" || (filter === "completed" ? row.status === "completed" : isOpen(row)));
  const openCount = rows?.filter(isOpen).length ?? 0;
  const link = portal ? `${window.location.origin}/feedback/${portal.slug}` : "";
  const settings = config && <PortalSettings sessionToken={sessionToken} projectId={projectId} projectName={projectName} portal={portal} onClose={() => setConfig(false)} />;

  if (portals === undefined) return <DelayedSkeleton rows={5} label="Loading feedback" />;
  if (!portal) return <section className="project-feedback" aria-label="Feedback">
    <ProjectEmpty icon={MessageSquare} title="No feedback form">{admin && <button className="primary-button compact" onClick={() => setConfig(true)}>Set up feedback</button>}</ProjectEmpty>
    {settings}
  </section>;

  return <section className="project-feedback" aria-label="Feedback">
    <div className="library-toolbar">
      <div className="segmented-control" role="group" aria-label="Show">{filters.map(item => <button key={item.value} type="button" className={item.value === filter ? "active" : ""} aria-pressed={item.value === filter} onClick={() => setFilter(item.value)}>{item.label}{item.value === "open" && openCount > 0 && <span>{openCount}</span>}</button>)}</div>
      <span className="library-toolbar-spacer" />
      {!portal.enabled && <span className="feedback-off">Form off</span>}
      {portal.enabled && <>
        <button className={clsx("icon-button", copied && "copied")} aria-label={copied ? "Copied" : "Copy form link"} title="Copy form link" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); window.clearTimeout(copyTimer.current); copyTimer.current = window.setTimeout(() => setCopied(false), 1600); } catch { setNotice("Copy was blocked by the browser"); } }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
        <a className="icon-button" title="Open form" aria-label="Open form" target="_blank" rel="noreferrer" href={link}><ArrowUpRight size={16} /></a>
      </>}
      {admin && <button className="icon-button" title="Form settings" aria-label="Form settings" onClick={() => setConfig(true)}><Settings2 size={16} /></button>}
    </div>
    {notice && <p className="notice danger" role="alert">{notice}<button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice("")}><X size={14} /></button></p>}
    {visible === undefined ? <DelayedSkeleton rows={5} label="Loading feedback" />
      : !visible.length ? <ProjectEmpty icon={MessageSquare} title={filter === "completed" ? "Nothing completed" : "No feedback"} />
        : <ul className="feedback-list">{visible.map(row => <li key={row._id} className={clsx("feedback-entry", row.status === "dismissed" && "dismissed")}>
          <span className={clsx("feedback-kind", row.kind)} aria-label={row.kind === "bug" ? "Bug" : "Idea"}>{row.kind === "bug" ? <Bug size={15} /> : <Lightbulb size={15} />}</span>
          <div className="feedback-main">
            <header><strong>{row.title}</strong>{row.status !== "new" && <span className={clsx("feature-status", row.status)}>{row.status}</span>}<time dateTime={new Date(row.createdAt).toISOString()}>{formatRelative(row.createdAt)}</time></header>
            <p>{row.body}</p>
          </div>
          <div className="feedback-actions">
            {row.taskId ? <button className="ghost-button compact" onClick={() => onOpenTask(portal.projectId, row.taskId!)}><ArrowUpRight size={14} />Open issue</button>
              : canEdit && row.status !== "dismissed" && <button className="ghost-button compact" onClick={() => setEntry(row)}><CirclePlus size={14} />Create issue</button>}
            {canEdit && !row.taskId && <button className="icon-button" title={row.status === "dismissed" ? "Restore" : "Dismiss"} aria-label={row.status === "dismissed" ? `Restore ${row.title}` : `Dismiss ${row.title}`} onClick={async () => { try { await dismiss({ sessionToken, teamId: workspace._id, entryId: row._id, dismissed: row.status !== "dismissed" }); } catch (error) { setNotice(errorText(error, "Could not update")); } }}>{row.status === "dismissed" ? <RotateCcw size={14} /> : <X size={14} />}</button>}
          </div>
        </li>)}</ul>}
    {settings}
    {entry && <ConvertFeedback sessionToken={sessionToken} projectId={portal.projectId} entry={entry} onClose={() => setEntry(null)} onCreated={taskId => { setEntry(null); onOpenTask(portal.projectId, taskId); }} />}
  </section>;
}

function PortalSettings({ sessionToken, projectId, projectName, portal, onClose }: { sessionToken: string; projectId: Id<"projects">; projectName: string; portal?: Portal; onClose: () => void }) {
  const workspace = useWorkspace(); const save = useMutation(api.feedback.configure);
  const [title, setTitle] = useState(portal?.title || projectName); const [description, setDescription] = useState(portal?.description || ""); const [enabled, setEnabled] = useState(portal ? portal.enabled : true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  return <Dialog title="Feedback form" onClose={onClose}><form className="stack-form library-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { await save({ sessionToken, teamId: workspace._id, projectId, title, description, enabled }); onClose(); } catch (error) { setError(errorText(error, "Could not save")); } finally { setBusy(false); } }}>
    <label>Title<input value={title} required maxLength={120} onChange={e => setTitle(e.target.value)} /></label>
    <label>Description<textarea value={description} maxLength={3000} rows={3} onChange={e => setDescription(e.target.value)} /></label>
    <label className="library-check"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable public feedback form</label>
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="library-form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy}>{busy && <Loader2 className="spin" size={15} />}Save settings</button></div>
  </form></Dialog>;
}

function ConvertFeedback({ sessionToken, projectId, entry, onClose, onCreated }: { sessionToken: string; projectId: Id<"projects">; entry: Entry; onClose: () => void; onCreated: (id: Id<"tasks">) => void }) {
  const workspace = useWorkspace(); const convert = useMutation(api.feedback.convert);
  const board = useQuery(api.tasks.board, { sessionToken, projectId }); const members = useQuery(api.members.people, { sessionToken, projectId }); const me = useQuery(api.auth.me, { sessionToken });
  const [column, setColumn] = useState(""); const [priority, setPriority] = useState<"low" | "medium" | "high">(entry.kind === "bug" ? "high" : "medium"); const [assignee, setAssignee] = useState(""); const [dueDate, setDueDate] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const columns = presentColumns(board?.columns.filter(c => !c.isDone && !/^done$/i.test(c.title)) || []);
  const defaultColumn = (columns.find(c => !isDraftColumn(c)) ?? columns[0])?._id || "";
  return <Dialog title="New issue" onClose={onClose}><form className="stack-form library-form" onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.requestSubmit(); } }} onSubmit={async e => { e.preventDefault(); if (busy || !columns.length) return; setBusy(true); setError(""); try { onCreated(await convert({ sessionToken, teamId: workspace._id, entryId: entry._id, columnId: (column || defaultColumn) as Id<"columns">, assignedToEmail: assignee, dueDate, priority })); } catch (error) { setError(errorText(error, "Could not create issue")); } finally { setBusy(false); } }}>
    <p className="library-form-subject">{entry.kind === "bug" ? <Bug size={14} /> : <Lightbulb size={14} />}<span>{entry.title}</span></p>
    {/* The composer's chips: status, priority, assignee, due date. */}
    <IssueFields columns={columns} members={members ?? []} currentEmail={me?.email} columnId={column || defaultColumn} onColumnChange={setColumn} priority={priority} onPriorityChange={setPriority} assignee={assignee} onAssigneeChange={setAssignee} dueDate={dueDate} onDueDateChange={setDueDate} disabled={busy} />
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="library-form-actions"><button type="button" className="ghost-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !columns.length}>{busy ? <Loader2 className="spin" size={15} /> : <CirclePlus size={15} />}Create issue</button></div>
  </form></Dialog>;
}
