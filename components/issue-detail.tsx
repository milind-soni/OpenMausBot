"use client";
import { errorText } from "@/lib/error-text";
import { ErrorBoundary } from "./error-boundary";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { useMutation, useQuery } from "convex/react";
import clsx from "clsx";
import { CheckCircle2, ChevronRight, CircleAlert, CircleDot, Copy, ExternalLink, GitBranch, GitPullRequest, LinkIcon, Loader2, Maximize2, MoreHorizontal, RotateCcw, Trash2, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { localApi } from "@/lib/client-api";
import { displayName, formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { taskKey } from "../lib/project-issues";
import { issuePath } from "@/lib/issue-route";
import { suggestLabels } from "@/lib/command-menu";
import { hasOpenKeyboardOverlay, isEditingTarget } from "@/lib/keyboard-navigation";
import { SubIssues } from "./sub-issues";
import { IssueLabels, IssueRelations } from "./issue-relations";
import { ProjectIcon } from "./project-icon";
import { useWorkspace } from "./workspace-context";
import { LocalAttachment } from "./local-attachment";
import { TaskPullRequests, createTaskPullRequest } from "./task-pull-request";
import { taskBranch } from "@/lib/task-branch";
import { Dialog } from "./dialog";
import { IssueFields, type IssueFieldKey } from "./issue-fields";
import { IssueCommentBody, IssueCommentComposer } from "./issue-comments";
import { IssueFileUpload } from "./issue-file-upload";
import { UserAvatar } from "./user-avatar";
import { useAnchoredPopover } from "./use-anchored-popover";
import { SheetHeader } from "./sheet-header";
import { useWorkspaceOnline } from "./workspace-connection";
import { IssueDeleteDialog, IssueToastHost, LoadingState, showIssueToast, type OpenReference, type ProjectWithUi } from "./issue-shared";

type Priority = "low" | "medium" | "high";
type Fields = { title: string; description: string; priority: Priority; assignedToEmail: string; dueDate: string };
type Notice = { text: string; tone?: "danger" } | null;

function parseGitHubRepo(repoUrl?: string) {
  if (!repoUrl) return null;
  const value = repoUrl.trim();
  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  const match = value.match(/github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}
const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ");
const sameField = (key: keyof Fields, a: string, b: string) => key === "title" || key === "description" ? a.trim() === b.trim() : a === b;
const fieldsOf = (task: { title: string; description?: string; priority: Priority; assignedToEmail?: string; dueDate?: string }): Fields => ({
  title: task.title, description: task.description || "", priority: task.priority, assignedToEmail: task.assignedToEmail || "", dueDate: task.dueDate || "",
});
const FIELD_ERROR_KEY: Partial<Record<keyof Fields, IssueFieldKey>> = { priority: "priority", assignedToEmail: "assignee", dueDate: "dueDate" };

/** Grows a textarea with its content where CSS `field-sizing` is not supported. */
function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || CSS.supports("field-sizing", "content")) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [ref, value]);
}

/**
 * Opening an issue from a click pushes a history entry, so the browser back gesture closes it; a deep link (the URL
 * already names the issue) keeps the current entry. Returns a function to call when the issue is closed from the UI.
 */
let ownedEntry: { taskId: string; length: number } | null = null;
function useIssueHistory(taskId: string, projectId: string, onBack: () => void, enabled = true) {
  const back = useRef(onBack);
  useEffect(() => { back.current = onBack; });
  const owns = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const url = new URL(window.location.href);
    const current = url.searchParams.get("issue");
    if (ownedEntry && ownedEntry.length === window.history.length && current === ownedEntry.taskId) {
      // Still on the entry an issue sheet pushed: a re-run for the same issue, or a related issue opened from it.
      if (current !== taskId) {
        url.searchParams.set("project", projectId);
        url.searchParams.set("issue", taskId);
        window.history.replaceState(window.history.state, "", url);
      }
      ownedEntry = { taskId, length: window.history.length };
      owns.current = true;
    } else if (current === taskId) owns.current = false;
    else {
      url.searchParams.set("project", projectId);
      url.searchParams.set("issue", taskId);
      window.history.pushState(window.history.state, "", url);
      ownedEntry = { taskId, length: window.history.length };
      owns.current = true;
    }
    const onPop = () => {
      if (new URL(window.location.href).searchParams.get("issue") === taskId) return;
      owns.current = false; ownedEntry = null;
      back.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [taskId, projectId, enabled]);
  return useCallback(() => {
    if (!owns.current) return;
    owns.current = false; ownedEntry = null;
    window.history.back();
  }, []);
}

/** Keeps the phone sheet inside the visible viewport, so the on-screen keyboard never covers the comment box. */
function useVisualViewportSheet(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const dialog = ref.current?.closest("dialog");
    const viewport = window.visualViewport;
    if (!dialog || !viewport) return;
    const phone = window.matchMedia("(max-width: 760px)");
    const fit = () => {
      if (!phone.matches) { dialog.style.removeProperty("height"); dialog.style.removeProperty("transform"); return; }
      dialog.style.height = `${viewport.height}px`;
      dialog.style.transform = viewport.offsetTop ? `translateY(${viewport.offsetTop}px)` : "";
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    phone.addEventListener("change", fit);
    return () => { viewport.removeEventListener("resize", fit); viewport.removeEventListener("scroll", fit); phone.removeEventListener("change", fit); };
  }, [ref]);
}

type IssueViewProps = Parameters<typeof TaskModalContent>[0];

/** Quick look at an issue over the current view (Space on a row or card, chat references). */
export function TaskModal(props: Omit<IssueViewProps, "variant">) {
  return <ErrorBoundary resetKey={props.taskId} fallback={<IssueUnavailable onClose={props.onClose} />}><TaskModalContent {...props} /></ErrorBoundary>;
}

/** The issue as a full page at its own URL; `onClose` goes back. Same fields, saving and activity as the dialog. */
export function IssuePage(props: Omit<IssueViewProps, "variant">) {
  return <ErrorBoundary resetKey={props.taskId} fallback={<IssuePageMessage title="Issue unavailable" body="This issue was deleted or you no longer have access to it." />}><TaskModalContent {...props} variant="page" /></ErrorBoundary>;
}

export function IssuePageMessage({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return <section className="issue-page issue-page-message"><div className="empty-block"><CircleAlert size={20} /><h3>{title}</h3><p>{body}</p>{children}</div></section>;
}

function IssueUnavailable({ onClose }: { onClose: () => void }) {
  return <Dialog title="Issue unavailable" className="issue-unavailable-dialog" onClose={onClose}>
    <div className="dialog-body issue-unavailable"><CircleAlert size={18} aria-hidden="true" /><p>This issue was deleted or you no longer have access to it.</p></div>
  </Dialog>;
}

function TaskModalContent({
  project,
  projectId,
  sessionToken,
  taskId,
  canEdit,
  onClose,
  onOpenReference,
  onDelete,
  onOpenProject,
  onOpenPage,
  variant = "dialog",
}: {
  project: ProjectWithUi;
  projectId: Id<"projects">;
  sessionToken: string;
  taskId: Id<"tasks">;
  canEdit: boolean;
  onClose: () => void;
  onOpenReference?: OpenReference;
  /** Deletes the issue in place of the view (the board: it closes the issue and focuses a neighbouring card). */
  onDelete?: () => void;
  /** The page's breadcrumb opens the project. */
  onOpenProject?: () => void;
  /** The dialog's expand button: open this issue as a page. */
  onOpenPage?: () => void;
  variant?: "dialog" | "page";
}) {
  const page = variant === "page";
  const details = useQuery(api.tasks.details, { projectId, sessionToken, taskId });
  const me = useQuery(api.auth.me, { sessionToken });
  const prs = useQuery(api.taskPRs.list, { taskId, sessionToken });
  const workspace = useWorkspace();
  const updateTask = useMutation(api.tasks.updateTask);
  const moveTask = useMutation(api.tasks.moveTask);
  const deleteTask = useMutation(api.tasks.deleteTask);
  const addAsset = useMutation(api.tasks.addAsset);
  const [fields, setFields] = useState<Fields | null>(null);
  const saved = useRef<Fields | null>(null);
  const [columnId, setColumnId] = useState<Id<"columns"> | "">("");
  const [errors, setErrors] = useState<Partial<Record<keyof Fields | "status", string>>>({});
  const [saving, setSaving] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);
  const [titleTouched, setTitleTouched] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const online = useWorkspaceOnline();
  const actionsTrigger = useRef<HTMLButtonElement>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const layout = useRef<HTMLDivElement>(null), titleInput = useRef<HTMLTextAreaElement>(null), descriptionInput = useRef<HTMLTextAreaElement>(null);
  useAutosize(titleInput, fields?.title || "");
  useAutosize(descriptionInput, fields?.description || "");
  useVisualViewportSheet(layout);

  // Follow server changes (other people, agents) for every field the user is not editing right now.
  const task = details?.task;
  useEffect(() => {
    if (!task) return;
    const server = fieldsOf(task);
    const previous = saved.current;
    saved.current = server;
    setFields(current => {
      if (!current || !previous) return server;
      const next = { ...current };
      for (const key of Object.keys(server) as (keyof Fields)[]) if (sameField(key, current[key], previous[key])) Object.assign(next, { [key]: server[key] });
      return next;
    });
    setColumnId(task.columnId);
  }, [task]);

  /** Saves the given fields of `values` that differ from the last saved state. Never throws; errors show inline. */
  const commit = useCallback((keys: (keyof Fields)[], values: Fields) => {
    if (!canEdit) return Promise.resolve();
    const run = async () => {
      const base = saved.current;
      if (!base) return;
      const patch: Partial<Fields> = {};
      for (const key of keys) {
        const value = key === "title" ? singleLine(values.title).trim() : key === "description" ? values.description.trim() : values[key];
        if (key === "title" && !value) continue;
        if (!sameField(key, value, base[key])) Object.assign(patch, { [key]: value });
      }
      if (!Object.keys(patch).length) return;
      setSaving(count => count + 1);
      try {
        await updateTask({ projectId, sessionToken, taskId, ...patch });
        saved.current = { ...(saved.current || base), ...patch };
        setErrors(current => { const next = { ...current }; for (const key of Object.keys(patch)) delete next[key as keyof Fields]; return next; });
      } catch (error) {
        const message = errorText(error, "Could not save");
        const failed = Object.keys(patch) as (keyof Fields)[];
        // Pickers snap back to the saved value; typed text stays so nothing is lost.
        setFields(current => {
          if (!current || !saved.current) return current;
          const next = { ...current };
          for (const key of failed) if (key !== "title" && key !== "description") Object.assign(next, { [key]: saved.current[key] });
          return next;
        });
        setErrors(current => ({ ...current, ...Object.fromEntries(failed.map(key => [key, message])) }));
      } finally { setSaving(count => count - 1); }
    };
    queue.current = queue.current.then(run, run);
    return queue.current;
  }, [canEdit, projectId, sessionToken, taskId, updateTask]);

  // Typing saves after a short pause.
  useEffect(() => {
    if (!fields || !saved.current) return;
    const handle = window.setTimeout(() => { void commit(["title", "description"], fields); }, 600);
    return () => window.clearTimeout(handle);
  }, [fields?.title, fields?.description, commit]); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    if (!fields) return;
    const next = { ...fields, [key]: value };
    setFields(next);
    setErrors(current => ({ ...current, [key]: undefined }));
    if (key !== "title" && key !== "description") void commit([key], next);
  };

  /** Saves typed text (an empty title falls back to the saved one) without waiting for it. */
  const flush = () => {
    if (fields && saved.current) void commit(["title", "description"], { ...fields, title: singleLine(fields.title).trim() ? fields.title : saved.current.title });
  };
  const releaseHistory = useIssueHistory(taskId, projectId, () => { flush(); onClose(); }, !page);
  const closeIssue = () => { flush(); releaseHistory(); onClose(); };

  const changeColumn = async (value: string) => {
    if (!canEdit || !value || value === columnId) return;
    const previous = columnId;
    setColumnId(value as Id<"columns">);
    setErrors(current => ({ ...current, status: undefined }));
    setSaving(count => count + 1);
    try { await moveTask({ projectId, sessionToken, taskId, columnId: value as Id<"columns"> }); }
    catch (error) { setColumnId(previous); setErrors(current => ({ ...current, status: errorText(error, "Could not change status") })); }
    finally { setSaving(count => count - 1); }
  };
  const openReference = (targetProject: Id<"projects">, targetTask?: Id<"tasks">) => {
    flush();
    if (onOpenReference) { onOpenReference(targetProject, targetTask); return; }
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ project: targetProject, ...(targetTask ? { issue: targetTask } : {}) }).toString();
    window.location.href = url.toString();
  };
  const copy = async (text: string, done: string, fallback: string) => {
    try { await navigator.clipboard.writeText(text); showIssueToast(done); }
    catch { setNotice({ text: fallback, tone: "danger" }); }
  };
  const issueUrl = () => new URL(issuePath(workspace.slug, taskId), window.location.origin).href;
  const copyLink = () => copy(issueUrl(), "Link copied", "Clipboard unavailable. Copy the link from the address bar.");
  const copyId = () => copy(taskKey(taskId), "Issue ID copied", `Clipboard unavailable. ID: ${taskKey(taskId)}`);

  /** Linear's habit: a branch named after the issue links its pull request and completes the issue on merge. */
  const copyBranch = async () => {
    if (!details) return;
    await copy(taskBranch(details.task), "Branch name copied", `Clipboard unavailable. Branch: ${taskBranch(details.task)}`);
  };

  const linkedGitHubAsset = details?.assets.find((asset) => asset.url.includes("github.com") && /\/issues\/\d+/.test(asset.url));
  const linkedGitHubUrl = details?.task.githubIssueUrl || linkedGitHubAsset?.url;
  const githubIssueNumber = details?.task.githubIssueNumber ?? linkedGitHubUrl?.match(/\/issues\/(\d+)/)?.[1];
  const repo = parseGitHubRepo(project.repoUrl);
  const taskMode = details?.task.githubTaskMode ?? project.githubTaskMode;
  const attachments = details?.assets.filter(asset => !asset.commentId && asset._id !== linkedGitHubAsset?._id) || [];
  const comments = details?.comments || [];
  const memberById = new Map(details?.members.map(member => [member.userId, member]) || []);

  const actions = canEdit && details ? [
    details.task.done
      ? { key: "reopen", label: "Reopen", icon: <RotateCcw size={14} />, run: async () => { await updateTask({ projectId, sessionToken, taskId, done: false }); } }
      : { key: "complete", label: "Mark complete", icon: <CheckCircle2 size={14} />, run: async () => {
        await updateTask({ projectId, sessionToken, taskId, done: true });
        // The same confirmation as completing a card on the board.
        showIssueToast("Completed", () => void updateTask({ projectId, sessionToken, taskId, done: false }).catch(error => setNotice({ text: errorText(error, "Could not reopen issue"), tone: "danger" })));
      } },
    ...(repo && !linkedGitHubUrl && taskMode !== "pull_request" ? [{ key: "github-issue", label: "Create GitHub issue", icon: <CircleDot size={14} />, run: async () => {
      flush(); await queue.current;
      const result = await localApi<{ message: string }>("/api/github/issues", sessionToken, { method: "POST", json: { projectId, taskId } });
      setNotice({ text: result.message });
    } }] : []),
    ...(repo ? [{ key: "branch", label: "Copy branch name", icon: <GitBranch size={14} />, run: copyBranch }] : []),
    // Projects set to mirror issues as draft PRs keep that path; elsewhere a PR links itself from its branch or "Closes" line.
    ...(repo && taskMode === "pull_request" && prs?.length === 0 ? [{ key: "pull-request", label: "Create draft PR", icon: <GitPullRequest size={14} />, run: async () => {
      flush(); await queue.current;
      setNotice({ text: await createTaskPullRequest(projectId, taskId, sessionToken) });
    } }] : []),
    { key: "delete", label: "Delete issue", icon: <Trash2 size={14} />, danger: true, run: async () => { setDeleting(true); } },
  ] : [];

  // Escape in a text field leaves the field first; the next Escape closes the issue.
  /** Linear's copy keys: Mod+. issue ID, Mod+Shift+, URL, Mod+Shift+. branch name. */
  const copyShortcut = (event: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "preventDefault">) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return false;
    if (event.key === ">" || (event.code === "Period" && event.shiftKey)) { if (!repo && !page) return false; event.preventDefault(); void copyBranch(); return true; }
    if (event.key === "<" || (event.code === "Comma" && event.shiftKey)) { event.preventDefault(); void copyLink(); return true; }
    if (event.code === "Period" && !event.shiftKey) { event.preventDefault(); void copyId(); return true; }
    return false;
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (copyShortcut(event)) { event.stopPropagation(); return; }
    if (event.key !== "Escape" || event.defaultPrevented || !target.matches("textarea, input")) return;
    event.preventDefault();
    target.blur();
    (page ? layout.current?.closest(".issue-page") : layout.current?.closest("dialog"))?.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
  };

  // On the page the copy keys work wherever focus is, and Escape (outside a field or menu) goes back.
  const pageKeys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const onPageKey = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (copyShortcut(event)) return;
    if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !isEditingTarget(event.target) && !hasOpenKeyboardOverlay()) { event.preventDefault(); closeIssue(); }
  };
  useEffect(() => { pageKeys.current = onPageKey; });
  useEffect(() => {
    if (!page) return;
    const handle = (event: KeyboardEvent) => pageKeys.current(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [page]);

  const key = details ? taskKey(details.task._id) : "";
  const titleEmpty = Boolean(fields && !singleLine(fields.title).trim());
  const reportError = (message: string) => setNotice({ text: message, tone: "danger" });
  const attachLink = (url: string) => { void addAsset({ projectId, taskId, sessionToken, type: "link", name: url, url }).catch(error => reportError(errorText(error, "Could not attach link"))); };
  const noticeBlock = notice && <div className={clsx("notice issue-detail-notice", notice.tone)} role={notice.tone ? "alert" : "status"}><span>{notice.text}</span><button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={14} /></button></div>;
  const titleBlock = fields && <div className="issue-title-block">
    {details?.task.done && <span className="issue-completed-badge"><CheckCircle2 size={13} />Completed</span>}
    <textarea ref={titleInput} className="issue-title-input" aria-label="Issue title" aria-invalid={titleEmpty || undefined} aria-describedby={titleEmpty && titleTouched ? `${taskId}-title-error` : undefined} value={fields.title} placeholder="Issue title" rows={1} maxLength={250} disabled={!canEdit}
      onChange={event => { setTitleTouched(true); setField("title", singleLine(event.target.value)); }}
      onBlur={() => void commit(["title"], fields)}
      onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); const description = descriptionInput.current; description?.focus(); description?.setSelectionRange(0, 0); } }} />
    {titleEmpty && titleTouched && <small id={`${taskId}-title-error`} className="issue-field-error" role="alert">{saved.current?.title ? "A title is required. Closing keeps the previous title." : "A title is required."}</small>}
    {errors.title && !titleEmpty && <small className="issue-field-error" role="alert">{errors.title}</small>}
  </div>;
  const descriptionBlock = fields && <>
    <textarea ref={descriptionInput} className="issue-detail-description" aria-label="Issue description" value={fields.description} onChange={event => setField("description", event.target.value)} onBlur={() => void commit(["description"], fields)} rows={2} placeholder={canEdit ? "Add a description..." : ""} disabled={!canEdit} maxLength={60000} />
    {errors.description && <small className="issue-field-error issue-description-error" role="alert">{errors.description}</small>}
  </>;
  const suggestions = fields ? suggestLabels(`${fields.title} ${fields.description}`) : [];
  const labelsField = <IssueLabels sessionToken={sessionToken} taskId={taskId} projectId={projectId} canEdit={canEdit} suggestions={suggestions} />;
  const githubLinks = (linkedGitHubUrl || !!prs?.length) && <div className="issue-github-links">
    {linkedGitHubUrl && <a className="issue-github-link" href={linkedGitHubUrl} target="_blank" rel="noreferrer"><CircleDot size={14} /><span>{githubIssueNumber ? `#${githubIssueNumber}` : "Issue"}</span><small>{repo ? `${repo.owner}/${repo.repo}` : ""}</small><ExternalLink size={12} /></a>}
    {prs && <TaskPullRequests prs={prs} />}
  </div>;
  const fieldsPanel = details && fields && <IssueFields labeled currentEmail={me?.email}
    columns={details.columns.filter(column => !(column.isDone ?? column.title.toLowerCase() === "done"))} members={details.members}
    columnId={columnId} onColumnChange={value => void changeColumn(value)}
    priority={fields.priority} onPriorityChange={value => setField("priority", value)}
    assignee={fields.assignedToEmail} onAssigneeChange={value => setField("assignedToEmail", value)}
    dueDate={fields.dueDate} onDueDateChange={value => setField("dueDate", value)} done={details.task.done}
    errors={{ status: errors.status, ...Object.fromEntries(Object.entries(FIELD_ERROR_KEY).map(([field, key]) => [key, errors[field as keyof Fields]])) }}
    disabled={!canEdit}>
    {!page && <div className="issue-property" data-field="labels"><span>Labels</span>{labelsField}</div>}
    {!page && githubLinks && <div className="issue-property" data-field="github"><span>GitHub</span>{githubLinks}</div>}
  </IssueFields>;
  const dateSummary = details && <dl className="issue-date-summary">
    <div><dt>Created</dt><dd title={formatDateTime(details.task.createdAt)}>{formatDate(details.task.createdAt)}</dd></div>
    <div><dt>Updated</dt><dd title={formatDateTime(details.task.updatedAt)}>{formatDate(details.task.updatedAt)}</dd></div>
  </dl>;
  const attachmentList = !!attachments.length && <div className="issue-attachments" aria-label="Attachments">{attachments.map(asset => asset.localFileId
    ? <LocalAttachment key={asset._id} file={{ id: asset.localFileId, name: asset.name, size: asset.size || 0, contentType: asset.contentType || "application/octet-stream" }} sessionToken={sessionToken} scope={`teamId=${workspace._id}`} />
    : <a key={asset._id} className="activity-attachment" href={asset.url} target="_blank" rel="noreferrer"><LinkIcon size={13} /><span>{asset.name}</span><ExternalLink size={12} /></a>)}</div>;
  const timeline = details && comments.map(comment => {
    const author = memberById.get(comment.authorUserId);
    return <article className="issue-timeline-entry" key={comment._id}>
      <UserAvatar user={author || { name: comment.authorName, email: comment.authorEmail }} size="small" />
      <div className="activity-entry-content"><header><strong>{author ? displayName(author) : comment.authorName}</strong><time dateTime={new Date(comment.createdAt).toISOString()} title={formatDateTime(comment.createdAt)}>{formatRelative(comment.createdAt)}</time></header>
        <IssueCommentBody comment={comment} sessionToken={sessionToken} canEdit={canEdit} members={details.members} onOpenReference={openReference} />
        <div className="comment-media">{details.assets.filter(asset => asset.commentId === comment._id && asset.localFileId).map(asset => <LocalAttachment key={asset._id} file={{ id: asset.localFileId!, name: asset.name, size: asset.size || 0, contentType: asset.contentType || "application/octet-stream" }} sessionToken={sessionToken} scope={`teamId=${workspace._id}`} />)}</div>
      </div>
    </article>;
  });
  const composer = canEdit && details && <IssueCommentComposer key={taskId} projectId={projectId} taskId={taskId} sessionToken={sessionToken} members={details.members} />;
  const deleteDialog = deleting && details && <IssueDeleteDialog taskId={taskId} title={details.task.title} disabled={!online} onCancel={() => {
    setDeleting(false);
    requestAnimationFrame(() => actionsTrigger.current?.focus({ preventScroll: true }));
  }} onConfirm={() => {
    setDeleting(false);
    if (onDelete) { releaseHistory(); onDelete(); return; }
    deleteTask({ projectId, sessionToken, taskId }).then(() => { releaseHistory(); onClose(); }, error => {
      setNotice({ text: errorText(error, "Could not delete issue"), tone: "danger" });
      requestAnimationFrame(() => actionsTrigger.current?.focus({ preventScroll: true }));
    });
  }} />;
  const saveState = saving > 0 && <span className="issue-save-state" role="status" aria-label="Saving"><Loader2 size={13} className="spin" /></span>;
  const actionsMenu = !!actions.length && <IssueActionsMenu trigger={actionsTrigger} actions={actions} onError={reportError} />;

  if (page) {
    const linkAssets = details?.assets.filter(asset => !asset.commentId && !asset.localFileId && asset._id !== linkedGitHubAsset?._id) ?? [];
    return <section className="issue-page" data-issue-page="" data-project-id={projectId} data-task-id={taskId} aria-label={details ? `${key} ${details.task.title}` : "Issue"}>
      <header className="issue-page-topbar">
        <h1 tabIndex={-1} data-initial-focus>
          <button type="button" className="issue-page-crumb" onClick={onOpenProject ?? onClose} title={`Back to ${project.name}`}><ProjectIcon project={project} /><span>{project.name}</span></button>
          <ChevronRight size={13} aria-hidden="true" />
          {details && <><span className="issue-key issue-page-key">{key}</span><span className="issue-page-title">{fields?.title || details.task.title}</span></>}
        </h1>
        {saveState}
        {actionsMenu}
      </header>
      {details && fields ? <IssueFileUpload className="issue-page-layout" projectId={projectId} taskId={taskId} sessionToken={sessionToken} disabled={!canEdit} onError={reportError} onLink={attachLink}>
        <div className="issue-page-scroll" ref={layout} onKeyDown={onKeyDown}>
          <div className="issue-page-main">
            {noticeBlock}
            {titleBlock}
            {descriptionBlock}
            {attachmentList}
            <SubIssues sessionToken={sessionToken} taskId={taskId} canEdit={canEdit} onOpen={openReference} />
            <IssueRelations sessionToken={sessionToken} projectId={projectId} taskId={taskId} canEdit={canEdit} onOpen={openReference} hideSubIssues />
            <section className="issue-activity issue-page-activity" aria-label="Activity">
              <h3>Activity</h3>
              <div className="issue-timeline">
                <div className="issue-timeline-event"><span aria-hidden="true" /><p>Issue created <time dateTime={new Date(details.task.createdAt).toISOString()} title={formatDateTime(details.task.createdAt)}>{formatRelative(details.task.createdAt)}</time></p></div>
                {timeline}
              </div>
              {composer && <div className="issue-page-composer">{composer}</div>}
            </section>
          </div>
        </div>
        <aside className="issue-page-rail" aria-label="Issue properties">
          <div className="issue-page-copy" role="group" aria-label="Copy">
            <button type="button" className="icon-button" aria-label="Copy issue URL" title="Copy issue URL (Ctrl/⌘ Shift ,)" onClick={() => void copyLink()}><LinkIcon size={15} /></button>
            <button type="button" className="icon-button" aria-label="Copy issue ID" title="Copy issue ID (Ctrl/⌘ .)" onClick={() => void copyId()}><Copy size={15} /></button>
            <button type="button" className="icon-button" aria-label="Copy git branch name" title="Copy git branch name (Ctrl/⌘ Shift .)" onClick={() => void copyBranch()}><GitBranch size={15} /></button>
          </div>
          <h2 className="issue-rail-heading">Properties</h2>
          {fieldsPanel}
          <h2 className="issue-rail-heading">Labels</h2>
          {labelsField}
          <h2 className="issue-rail-heading">Project</h2>
          <button type="button" className="issue-rail-project" onClick={onOpenProject ?? onClose}><ProjectIcon project={project} /><span>{project.name}</span></button>
          <h2 className="issue-rail-heading">Links</h2>
          <div className="issue-rail-links">
            {githubLinks}
            {linkAssets.map(asset => <a key={asset._id} className="issue-github-link" href={asset.url} target="_blank" rel="noreferrer"><LinkIcon size={14} /><span>{asset.name}</span><ExternalLink size={12} /></a>)}
            {!githubLinks && !linkAssets.length && <p className="issue-empty-value">No links yet. Paste or drop a URL on the issue{repo ? ", or push a branch named after it to link its pull request" : ""}.</p>}
          </div>
          {dateSummary}
        </aside>
      </IssueFileUpload> : <div className="issue-detail-loading" ref={layout}><LoadingState label="Opening issue" /></div>}
      {deleteDialog}
      <IssueToastHost />
    </section>;
  }

  return <Dialog title={details ? `${key} ${details.task.title}` : "Issue"} className="issue-detail-dialog" onClose={closeIssue} heading={<div className="issue-detail-heading">
      <h2 tabIndex={-1} data-initial-focus><ProjectIcon project={project} /><span>{project.name}</span>{details && <><ChevronRight size={13} aria-hidden="true" /><span className="issue-detail-key issue-key">{key}</span></>}</h2>
      {saveState}
      {details && onOpenPage && <button type="button" className="icon-button" aria-label="Open issue page" title="Open full page" onClick={() => { flush(); ownedEntry = null; onOpenPage(); }}><Maximize2 size={14} /></button>}
      {details && <button type="button" className="icon-button" aria-label="Copy link" title="Copy link" onClick={() => void copyLink()}><LinkIcon size={15} /></button>}
      {actionsMenu}
    </div>}>
    {details && fields ? <IssueFileUpload className="issue-detail-layout" projectId={projectId} taskId={taskId} sessionToken={sessionToken} disabled={!canEdit} onError={reportError} onLink={attachLink}>
      <div className="issue-detail-main" ref={layout} onKeyDown={onKeyDown}>
        {noticeBlock}
        {titleBlock}
        {descriptionBlock}
        <aside className="issue-detail-sidebar" aria-label="Issue properties">
          {fieldsPanel}
          {dateSummary}
        </aside>
        <IssueRelations sessionToken={sessionToken} projectId={projectId} taskId={taskId} canEdit={canEdit} onOpen={openReference} />
        {attachmentList}
        {!!comments.length && <section className="issue-activity" aria-label="Activity">
          <h3>Activity</h3>
          <div className="issue-timeline">{timeline}</div>
        </section>}
      </div>
      {composer && <div className="issue-detail-composer" onKeyDown={onKeyDown}>{composer}</div>}
    </IssueFileUpload> : <div className="issue-detail-loading" ref={layout}><LoadingState label="Opening issue" /></div>}
    {deleteDialog}
    <IssueToastHost />
  </Dialog>;
}

type IssueAction = { key: string; label: string; icon: ReactNode; danger?: boolean; run: () => Promise<unknown> };

function IssueActionsMenu({ actions, trigger, onError }: { actions: IssueAction[]; trigger: RefObject<HTMLButtonElement | null>; onError: (message: string) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState("");
  const menu = useRef<HTMLDivElement>(null), first = useRef<HTMLButtonElement>(null);
  useAnchoredPopover(open, trigger, menu, first, { width: 210, onDismiss: restore => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); } });
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  const run = async (action: IssueAction) => {
    setBusy(action.key);
    try { await action.run(); close(); }
    catch (error) { onError(errorText(error, `Could not ${action.label.toLowerCase()}`)); setOpen(false); }
    finally { setBusy(""); }
  };
  return <div className="issue-actions" onKeyDown={event => {
    if (!open) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    event.preventDefault(); items[next]?.focus({ preventScroll: true });
  }}>
    <button ref={trigger} type="button" className="icon-button" aria-label="Issue actions" title="Issue actions" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (open) close(); else setOpen(true); }}><MoreHorizontal size={16} /></button>
    {open && <div ref={menu} popover="manual" role="menu" aria-label="Issue actions" className="origin-dropdown issue-actions-menu">
      <SheetHeader caption="Actions" />
      {actions.map((action, index) => <button key={action.key} ref={index === 0 ? first : undefined} type="button" role="menuitem" className={clsx(action.danger && "danger-text")} disabled={Boolean(busy)} onClick={() => void run(action)}>
        {busy === action.key ? <Loader2 size={14} className="spin" /> : action.icon}<span>{action.label}</span>
      </button>)}
    </div>}
  </div>;
}
