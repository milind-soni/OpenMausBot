"use client";
import { errorText } from "@/lib/error-text";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, Circle, Loader2, Tag } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isDraftColumn } from "@/lib/origin-columns";
import { Dialog } from "./dialog";
import { announceCreatedIssue } from "./issue-shared";
import { IssueFields } from "./issue-fields";
import { IssueSelect } from "./issue-select";
import { ProjectIcon } from "./project-icon";
import { rankSearchResults } from "@/lib/search-ranking";
import { RECONNECT_TO_CREATE, useWorkspaceOnline } from "./workspace-connection";
import { LabelChips, LabelPicker } from "./issue-labels";
import { suggestLabels } from "@/lib/command-menu";

type Priority = "low" | "medium" | "high";
type Draft = { title: string; description: string; columnId: string; priority: Priority; assignee: string; dueDate: string; labels: string[] };

const EMPTY_DRAFT: Draft = { title: "", description: "", columnId: "", priority: "medium", assignee: "", dueDate: "", labels: [] };
const draftKey = (projectId: string) => `origin.issueDraft.${projectId}`;
/** Unsent issue drafts live in this browser, one per project, so closing the composer never loses typed text. */
function readDraft(projectId: string): Draft | null {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(projectId)) || "null") as Partial<Draft> | null;
    return value && (value.title || value.description) ? { ...EMPTY_DRAFT, ...value, labels: Array.isArray(value.labels) ? value.labels.filter(label => typeof label === "string") : [] } : null;
  } catch { return null; }
}
function writeDraft(projectId: string, draft: Draft | null) {
  try {
    if (draft && (draft.title.trim() || draft.description.trim())) localStorage.setItem(draftKey(projectId), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(projectId));
  } catch { /* Storage can be unavailable (private mode); the draft then lives only while the composer is open. */ }
}

export function IssueComposer({
  sessionToken,
  projects,
  activeProjectId,
  onClose,
  onCreated,
  initialDraft,
  initialColumnId,
}: {
  sessionToken: string;
  projects: { _id: Id<"projects">; name: string; memberRole: string; iconType?: string; iconValue?: string; iconUrl?: string | null }[];
  activeProjectId: Id<"projects"> | null;
  onClose: () => void;
  onCreated: (id: Id<"projects">, taskId: Id<"tasks">) => void;
  initialDraft?: { title: string; description: string };
  /** Lane the issue starts in (a board lane's + button). */
  initialColumnId?: string;
}) {
  const online = useWorkspaceOnline();
  const editable = projects.filter((p) => p.memberRole !== "viewer");
  const [projectId, setProjectId] = useState<Id<"projects"> | null>(editable.find((p) => p._id === activeProjectId)?._id || null);
  const [draft, setDraft] = useState<Draft>(() => {
    if (initialDraft) return { ...EMPTY_DRAFT, ...initialDraft, columnId: initialColumnId || "" };
    const stored = projectId ? readDraft(projectId) : null;
    return stored ? { ...stored, columnId: initialColumnId || stored.columnId } : { ...EMPTY_DRAFT, columnId: initialColumnId || "" };
  });
  const dirty = useRef(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectIndex, setProjectIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [titleError, setTitleError] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null), descriptionInput = useRef<HTMLTextAreaElement>(null);
  const matchingProjects = rankSearchResults(editable.map(project => ({ ...project, label: project.name })).filter(project => project.name.toLowerCase().includes(projectSearch.toLowerCase())), projectSearch);
  const board = useQuery(api.tasks.board, projectId ? { sessionToken, projectId } : "skip");
  const members = useQuery(api.members.people, projectId ? { sessionToken, projectId } : "skip");
  const me = useQuery(api.auth.me, { sessionToken });
  const create = useMutation(api.tasks.createTask);
  const saveLabels = useMutation(api.issueRelations.labels);
  const ensureColumns = useMutation(api.tasks.ensureDefaultColumns);
  const columns = board?.columns.filter((c) => !(c.isDone ?? c.title.toLowerCase() === "done")) || [];
  const selectedColumn = columns.find((c) => c._id === draft.columnId) || columns.find(column => !isDraftColumn(column)) || columns[0];

  useEffect(() => {
    if (!projectId) return;
    const frame = requestAnimationFrame(() => titleInput.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [projectId]);
  useEffect(() => {
    if (online && board?.columns.length === 0 && projectId)
      void ensureColumns({ sessionToken, projectId }).catch((error) => setError(errorText(error, "Could not prepare columns")));
  }, [online, board?.columns.length, projectId, ensureColumns, sessionToken]);
  // Keep the draft in this browser as the user types.
  useEffect(() => { if (projectId && dirty.current) writeDraft(projectId, draft); }, [projectId, draft]);

  const update = (patch: Partial<Draft>) => { dirty.current = true; setDraft(current => ({ ...current, ...patch })); setError(""); };
  const chooseProject = (next: Id<"projects">) => {
    if (next === projectId) return;
    const stored = readDraft(next);
    // Typed text follows the user to the new project; project-specific fields reset.
    setDraft(current => current.title || current.description ? { ...EMPTY_DRAFT, title: current.title, description: current.description } : stored || EMPTY_DRAFT);
    if (projectId && dirty.current) writeDraft(projectId, null);
    setProjectId(next);
  };
  const close = () => { if (busy) return; if (projectId && dirty.current) writeDraft(projectId, draft); onClose(); };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!online || busy || !projectId || !selectedColumn) return;
    if (!draft.title.trim()) { setTitleError(true); titleInput.current?.focus(); return; }
    setBusy(true);
    setError("");
    try {
      const taskId = await create({
        projectId,
        sessionToken,
        columnId: selectedColumn._id,
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        ...(draft.assignee ? { assignedToEmail: draft.assignee } : {}),
        ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
      });
      // Labels go on right after; the issue exists either way, so a label error does not lose it.
      if (draft.labels.length) await saveLabels({ sessionToken, taskId, labels: draft.labels }).catch(() => undefined);
      dirty.current = false;
      writeDraft(projectId, null);
      onCreated(projectId, taskId);
      announceCreatedIssue(taskId);
      onClose();
    } catch (error) {
      setError(errorText(error, "Could not create issue"));
    } finally {
      setBusy(false);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };

  return (
    <Dialog
      title="New issue"
      heading={<div className="issue-breadcrumb"><IssueSelect label="Project" icon={<Circle size={14} />} value={projectId || ""} disabled={busy} onChange={value => chooseProject(value as Id<"projects">)} options={editable.map(project => ({ value: project._id, label: project.name, icon: <ProjectIcon project={project} size={14} /> }))} placeholder="Project" caption="Project" /><ChevronRight size={14} aria-hidden="true" /><h2>New issue</h2></div>}
      className="issue-composer-dialog"
      onClose={close}
    >
      <form onSubmit={submit} onKeyDown={onKeyDown} noValidate>
        {!editable.length ? (
          <div className="dialog-body muted">Create a project first.</div>
        ) : !projectId ? (
          <div className="issue-project-choice">
            <input type="search" role="combobox" aria-expanded="true" aria-controls="new-issue-projects" aria-activedescendant={matchingProjects[projectIndex] ? `choose-${matchingProjects[projectIndex]._id}` : undefined} aria-label="Choose a project" placeholder="Choose a project..." autoFocus data-initial-focus value={projectSearch} onChange={event => { setProjectSearch(event.target.value); setProjectIndex(0); }} onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") { event.preventDefault(); if (matchingProjects[projectIndex]) chooseProject(matchingProjects[projectIndex]._id); }
              else if (["ArrowDown", "ArrowUp"].includes(event.key) && matchingProjects.length) { event.preventDefault(); setProjectIndex(index => (index + (event.key === "ArrowDown" ? 1 : -1) + matchingProjects.length) % matchingProjects.length); }
            }} />
            <div className="issue-project-options" id="new-issue-projects" role="listbox" aria-label="Projects">
              {matchingProjects.map((project, index) => <button id={`choose-${project._id}`} key={project._id} type="button" role="option" aria-selected={index === projectIndex} tabIndex={-1} onMouseEnter={() => setProjectIndex(index)} onClick={() => chooseProject(project._id)}><ProjectIcon project={project} size={16} /><span>{project.name}</span></button>)}
              {!matchingProjects.length && <p className="muted">No matching projects</p>}
            </div>
          </div>
        ) : (
          <div className="issue-composer-fields">
            <input
              ref={titleInput}
              className="issue-title-input"
              aria-label="Issue title"
              aria-invalid={titleError || undefined}
              aria-describedby={titleError ? "issue-composer-title-error" : undefined}
              autoFocus
              data-initial-focus
              value={draft.title}
              onChange={(e) => { update({ title: e.target.value }); setTitleError(false); }}
              onKeyDown={event => { if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) { event.preventDefault(); descriptionInput.current?.focus(); } }}
              placeholder="Issue title"
              maxLength={250}
              readOnly={busy}
            />
            {titleError && <small id="issue-composer-title-error" className="issue-field-error" role="alert">Add a title</small>}
            <textarea
              ref={descriptionInput}
              aria-label="Issue description"
              value={draft.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Add a description..."
              rows={3}
              readOnly={busy}
              maxLength={60000}
            />
            <IssueFields
              columns={columns}
              members={members || []}
              currentEmail={me?.email}
              columnId={selectedColumn?._id || ""}
              onColumnChange={columnId => update({ columnId })}
              priority={draft.priority}
              onPriorityChange={priority => update({ priority })}
              assignee={draft.assignee}
              onAssigneeChange={assignee => update({ assignee })}
              dueDate={draft.dueDate}
              onDueDateChange={dueDate => update({ dueDate })}
              disabled={busy}
            >
              <LabelPicker value={draft.labels} onChange={labels => update({ labels })} suggestions={suggestLabels(`${draft.title} ${draft.description}`, draft.labels)} disabled={busy}
                className="composer-labels" trigger={() => draft.labels.length ? <LabelChips labels={draft.labels} max={3} /> : <><Tag size={13} /><span>Labels</span></>} />
            </IssueFields>
            {suggestLabels(`${draft.title} ${draft.description}`, draft.labels).length > 0 && <div className="composer-label-suggestions" aria-label="Suggested labels">
              <span>Suggested</span>
              {suggestLabels(`${draft.title} ${draft.description}`, draft.labels).map(label => <button key={label} type="button" className="ghost-button compact" onClick={() => update({ labels: [...draft.labels, label] })}><LabelChips labels={[label]} /></button>)}
            </div>}
            <footer className="issue-composer-footer">
              {error ? <div role="alert" className="issue-field-error">{error}</div> : <span />}
              <button type="submit" className="primary-button compact issue-create-submit" aria-keyshortcuts="Control+Enter Meta+Enter" title={!online ? RECONNECT_TO_CREATE : undefined} disabled={!online || busy || !selectedColumn}>
                {busy && <Loader2 size={14} className="spin" />}
                Create issue
                <kbd aria-hidden="true">{typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵"}</kbd>
              </button>
            </footer>
          </div>
        )}
      </form>
    </Dialog>
  );
}
