"use client";
import { errorText } from "@/lib/error-text";
import { useMutation, useQuery } from "convex/react";
import { Code2, ImageUp, KeyRound, Layers, Loader2, MessagesSquare, Power, Settings, Shapes, type LucideIcon } from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { normalizeProjectEmoji } from "@/lib/project-emoji";
import { BoardTab } from "./project-issues";
import { AssetsPanel, FeedbackView, IssueComposer, ProjectMembers, TaskModal, VaultPanel } from "./lazy-views";
import { ProjectCode } from "./project-code";
import { TAB_ALIASES, TAB_KEYS, tabFromQuery, type CodeSection, type TabKey } from "@/lib/project-tabs";
export type { TabKey } from "@/lib/project-tabs";
import { ProjectIcon, ProjectIconPicker } from "./project-icon";
import { DelayedSkeleton } from "./delayed-skeleton";
import { ConfirmButton } from "./confirm-button";
import { useWorkspace } from "./workspace-context";
import type { AuthUser } from "./origin-app";

type ProjectIconType = "default" | "emoji" | "icon" | "image";
type ProjectWithUi = Doc<"projects"> & { memberRole: string; iconUrl?: string | null; openIssueCount?: number };
type AvatarUser = { username?: string; name: string; email: string; avatarUrl?: string | null };

export const tabs: Array<{ key: Exclude<TabKey, "settings">; label: string; icon: LucideIcon }> = [
  { key: "issues", label: "Issues", icon: Layers },
  { key: "code", label: "Code", icon: Code2 },
  { key: "assets", label: "Assets", icon: Shapes },
  { key: "vault", label: "Vault", icon: KeyRound },
  { key: "feedback", label: "Feedback", icon: MessagesSquare },
];
const tabKeys: readonly TabKey[] = TAB_KEYS;

const tabFromLocation = () => tabFromQuery(new URLSearchParams(window.location.search).get("tab"));

/**
 * Keeps the queries of tabs that were visited (or hovered) subscribed, so switching back to them renders their data
 * at once instead of a skeleton. Rendered as its own component so its updates never re-render the open tab.
 * Arguments match the tabs' own useQuery calls key for key, which is what lets Convex share the subscription.
 */
function TabWarmers({ projectId, sessionToken, teamId, warm }: { projectId: Id<"projects">; sessionToken: string; teamId: Id<"teams">; warm: ReadonlySet<TabKey> }) {
  const scope = { projectId, sessionToken };
  useQuery(api.tasks.board, warm.has("issues") ? scope : "skip");
  useQuery(api.members.people, warm.has("issues") || warm.has("settings") ? scope : "skip");
  useQuery(api.taskPRs.projectPullRequests, warm.has("code") ? scope : "skip");
  useQuery(api.design.list, warm.has("assets") ? scope : "skip");
  useQuery(api.credentials.list, warm.has("vault") ? scope : "skip");
  useQuery(api.commits.list, warm.has("code") ? scope : "skip");
  const portals = useQuery(api.feedback.portals, warm.has("feedback") ? { sessionToken, teamId } : "skip");
  const portal = portals?.find(item => item.projectId === projectId);
  useQuery(api.feedback.list, warm.has("feedback") && portal ? { sessionToken, teamId, portalId: portal._id } : "skip");
  return null;
}

export function ProjectWorkspace({ projectId, sessionToken, user, initialTaskId, onOpenReference }: { projectId: Id<"projects">; sessionToken: string; user: AuthUser; viewers: Array<AvatarUser & { userId: string }>; initialTaskId?: Id<"tasks">; onOpenReference: (projectId: Id<"projects">, taskId?: Id<"tasks">) => void }) {
  const workspace = useWorkspace();
  const [initial] = useState(() => typeof window === "undefined" ? { tab: "issues" as TabKey } : tabFromLocation());
  const [tab, setTab] = useState<TabKey>(initial.tab);
  const [codeSection, setCodeSection] = useState<CodeSection | undefined>(initial.section);
  const [warm, setWarm] = useState<ReadonlySet<TabKey>>(() => new Set<TabKey>(["issues", tab]));
  const [issueOpen, setIssueOpen] = useState(false);
  const [pendingTask, setPendingTask] = useState(initialTaskId);
  // An issue opened over a tab other than Issues (Feedback, Code).
  const [peekTask, setPeekTask] = useState<Id<"tasks"> | null>(null);
  const project = useQuery(api.projects.get, { projectId, sessionToken });

  const warmTab = useCallback((key: TabKey) => setWarm(current => current.has(key) ? current : new Set([...current, key])), []);
  // Back and forward move between tabs of this project.
  useEffect(() => {
    const onPop = () => {
      const shown = new URLSearchParams(window.location.search).get("project");
      if (shown && shown !== projectId) return;
      const next = tabFromLocation();
      warmTab(next.tab);
      setTab(next.tab);
      setCodeSection(next.section);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [projectId, warmTab]);

  // An old Repo or Pull requests link opened Code: show the current name in the address bar.
  useEffect(() => {
    const url = new URL(window.location.href);
    const value = url.searchParams.get("tab");
    if (value && TAB_ALIASES[value] && value !== tab) { url.searchParams.set("tab", tab); window.history.replaceState(window.history.state, "", url); }
  }, [tab]);

  const openTab = (key: TabKey) => {
    if (key === tab) return;
    warmTab(key);
    setTab(key);
    setCodeSection(undefined);
    setPendingTask(undefined);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", key);
    url.searchParams.delete("issue");
    window.history.pushState(null, "", url);
  };

  // The warmers mount before the project arrives, so the board's queries load alongside it instead of after it.
  const warmers = <TabWarmers projectId={projectId} sessionToken={sessionToken} teamId={workspace._id} warm={warm} />;
  if (!project) return <>{warmers}<DelayedSkeleton kind="board" label="Opening project" /></>;
  const canEdit = project.memberRole !== "viewer";
  return (<>
    {warmers}
    <div className="project-shell">
      <ProjectHeader project={project} tab={tab} onSelect={openTab} onIntent={warmTab} />
      {project.status !== "active" && <ProjectStateBanner project={project} sessionToken={sessionToken} />}
      <div key={tab} className="project-panel" data-tab={tab} role="tabpanel" id="project-panel" aria-labelledby={`project-tab-${tab}`}>
        {tab === "issues" && <BoardTab key={projectId} project={project} projectId={projectId} sessionToken={sessionToken} userEmail={user.email} canEdit={canEdit} onCreateIssue={() => setIssueOpen(true)} initialTaskId={pendingTask} onOpenReference={onOpenReference} />}
        {tab === "code" && <ProjectCode project={project} sessionToken={sessionToken} initialSection={codeSection} onOpenIssue={setPeekTask} />}
        {tab === "assets" && <AssetsPanel projectId={projectId} sessionToken={sessionToken} canEdit={canEdit} />}
        {tab === "vault" && <VaultPanel projectId={projectId} sessionToken={sessionToken} canEdit={canEdit} />}
        {tab === "feedback" && <FeedbackView key={projectId} projectId={projectId} projectName={project.name} sessionToken={sessionToken} canEdit={canEdit} onOpenTask={(_, taskId) => setPeekTask(taskId)} />}
        {tab === "settings" && <SettingsTab project={project} sessionToken={sessionToken} />}
      </div>
      {peekTask && <TaskModal project={project} projectId={projectId} sessionToken={sessionToken} taskId={peekTask} canEdit={canEdit} onClose={() => setPeekTask(null)} />}
      {issueOpen && <IssueComposer sessionToken={sessionToken} activeProjectId={projectId} projects={[project]} onClose={() => setIssueOpen(false)} onCreated={() => openTab("issues")} />}
    </div>
  </>);
}

/**
 * Project identity, the tab menu and the settings tab at the end. An ARIA tablist with manual activation: arrow keys,
 * Home and End move focus; Enter, Space or a click opens the tab (so arrowing across never stacks history entries).
 */
function ProjectHeader({ project, tab, onSelect, onIntent }: { project: ProjectWithUi; tab: TabKey; onSelect: (key: TabKey) => void; onIntent: (key: TabKey) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  // Roving tab stop: the tab that holds focus while arrowing, otherwise the open tab.
  const [focusKey, setFocusKey] = useState<TabKey | null>(null);

  const measureEdges = useCallback(() => {
    const list = scroller.current;
    if (!list) return;
    const start = list.scrollLeft > 2, end = list.scrollLeft + list.clientWidth < list.scrollWidth - 2;
    setEdges(current => current.start === start && current.end === end ? current : { start, end });
  }, []);

  // Scroll the open tab into view on narrow screens.
  useLayoutEffect(() => {
    const list = scroller.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (list && active) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const pad = 24;
      const left = active.offsetLeft - pad, right = active.offsetLeft + active.offsetWidth + pad - list.clientWidth;
      if (list.scrollLeft > left) list.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
      else if (list.scrollLeft < right) list.scrollTo({ left: right, behavior: reduce ? "auto" : "smooth" });
    }
  }, [tab]);
  useEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const observer = new ResizeObserver(measureEdges);
    observer.observe(list);
    list.addEventListener("scroll", measureEdges, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener("scroll", measureEdges); };
  }, [measureEdges]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabKeys.indexOf((event.target as HTMLElement).dataset.tab as TabKey);
    if (index < 0) return;
    const next = event.key === "ArrowRight" ? tabKeys[(index + 1) % tabKeys.length]
      : event.key === "ArrowLeft" ? tabKeys[(index - 1 + tabKeys.length) % tabKeys.length]
        : event.key === "Home" ? tabKeys[0] : event.key === "End" ? tabKeys[tabKeys.length - 1] : null;
    if (!next) return;
    event.preventDefault();
    setFocusKey(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus();
  };

  const tabProps = (key: TabKey) => ({
    role: "tab" as const,
    id: `project-tab-${key}`,
    "data-tab": key,
    "aria-selected": tab === key,
    "aria-controls": tab === key ? "project-panel" : undefined,
    tabIndex: (focusKey ?? tab) === key ? 0 : -1,
    onClick: () => { setFocusKey(null); onSelect(key); },
    onPointerEnter: () => onIntent(key),
    onFocus: () => { setFocusKey(key); onIntent(key); },
  });

  return <header className="project-navigation">
    <div className="project-identity"><ProjectIcon project={project} /><h1>{project.name}</h1></div>
    <div className="project-tabs" role="tablist" aria-label="Project" onKeyDown={onKeyDown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusKey(null); }}>
      <div ref={scroller} className="project-tab-scroll" data-fade-start={edges.start || undefined} data-fade-end={edges.end || undefined}>
        {tabs.map(({ key, label, icon: Icon }) => <button key={key} type="button" className="project-tab" {...tabProps(key)}><Icon size={14} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span></button>)}
      </div>
      <button type="button" className="project-settings-tab" aria-label="Settings" title="Settings" {...tabProps("settings")}><Settings size={15} strokeWidth={1.75} /></button>
    </div>
  </header>;
}

function ProjectStateBanner({ project, sessionToken }: { project: ProjectWithUi; sessionToken: string }) {
  const update = useMutation(api.projects.update);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="project-state-banner" role="status"><Power size={14} /><span>Inactive project</span>{error && <span className="danger-text" role="alert">{error}</span>}{["owner", "admin"].includes(project.memberRole) && <button className="ghost-button compact" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await update({ sessionToken, projectId: project._id, status: "active" }); } catch (error) { setError(errorText(error, "Could not reactivate")); } finally { setBusy(false); } }}>{busy && <Loader2 className="spin" size={13} />}Reactivate</button>}</div>;
}

const iconTypes: Array<{ value: ProjectIconType; label: string }> = [
  { value: "default", label: "None" },
  { value: "emoji", label: "Emoji" },
  { value: "icon", label: "Icon" },
  { value: "image", label: "Image" },
];

function SettingsTab({ project, sessionToken }: { project: ProjectWithUi; sessionToken: string }) {
  const updateProject = useMutation(api.projects.update);
  const generateIconUploadUrl = useMutation(api.projects.generateIconUploadUrl);
  const initial = useMemo(() => ({
    name: project.name,
    description: project.description || "",
    iconType: (project.iconType as ProjectIconType | undefined) || "default",
    iconEmoji: project.iconType === "emoji" ? project.iconValue || "" : "",
    iconName: (project.iconType === "icon" ? project.iconValue : "circle") || "circle",
  }), [project.description, project.iconType, project.iconValue, project.name]);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [iconType, setIconType] = useState<ProjectIconType>(initial.iconType);
  const [iconEmoji, setIconEmoji] = useState(initial.iconEmoji);
  const [iconName, setIconName] = useState(initial.iconName);
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  // Saved values changed elsewhere (another tab, another person): show them.
  const [shown, setShown] = useState(initial);
  if (shown !== initial) {
    setShown(initial);
    setName(initial.name);
    setDescription(initial.description);
    setIconType(initial.iconType);
    setIconEmoji(initial.iconEmoji);
    setIconName(initial.iconName);
  }
  const preview = useMemo(() => iconFile ? URL.createObjectURL(iconFile) : null, [iconFile]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const dirty = name !== initial.name || description !== initial.description || iconType !== initial.iconType || Boolean(iconFile)
    || (iconType === "emoji" && iconEmoji !== initial.iconEmoji) || (iconType === "icon" && iconName !== initial.iconName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      if (!name.trim()) throw new Error("Enter a project name");
      if (iconType === "image" && !iconFile && !(project.iconType === "image" && project.iconUrl)) throw new Error("Choose an image");
      if (iconType === "emoji" && !normalizeProjectEmoji(iconEmoji)) throw new Error("Enter an emoji");
      let iconStorageId: Id<"_storage"> | undefined;
      if (iconType === "image" && iconFile) {
        const uploadUrl = await generateIconUploadUrl({ projectId: project._id, sessionToken });
        const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": iconFile.type || "application/octet-stream" }, body: iconFile });
        if (!res.ok) throw new Error("Icon upload failed");
        const payload = (await res.json()) as { storageId: Id<"_storage"> };
        iconStorageId = payload.storageId;
      }
      await updateProject({
        projectId: project._id,
        sessionToken,
        name,
        description,
        iconType,
        ...(iconType === "emoji" ? { iconValue: normalizeProjectEmoji(iconEmoji) } : {}),
        ...(iconType === "icon" ? { iconValue: iconName } : {}),
        ...(iconStorageId ? { iconStorageId } : {}),
      });
      setIconFile(null);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
    } catch (error) { setError(errorText(error, "Could not save project")); }
    finally { setBusy(false); }
  };
  const setStatus = async (status: "active" | "inactive") => {
    setStatusError("");
    try { await updateProject({ projectId: project._id, sessionToken, status }); }
    catch (error) { setStatusError(errorText(error, "Could not update project")); }
  };
  if (!["owner", "admin"].includes(project.memberRole)) return <div className="project-settings"><section className="project-settings-section"><h2>Members</h2><ProjectMembers projectId={project._id} sessionToken={sessionToken} /></section></div>;
  const previewProject = iconType === "image" ? { iconType: "image", iconUrl: preview || (project.iconType === "image" ? project.iconUrl : null) } : { iconType, iconValue: iconType === "emoji" ? iconEmoji : iconName };
  return <div className="project-settings">
    <section className="project-settings-section" aria-labelledby="project-settings-general">
      <h2 id="project-settings-general">General</h2>
      <form className="project-settings-form" onSubmit={submit}>
        <div className="project-settings-field">
          <span className="project-settings-label" id="project-icon-label">Icon</span>
          <div className="project-icon-field">
            <span className="project-icon-preview"><ProjectIcon project={previewProject} size={20} /></span>
            <div className="segmented-control" role="radiogroup" aria-labelledby="project-icon-label">{iconTypes.map(item => <button key={item.value} type="button" role="radio" aria-checked={iconType === item.value} className={iconType === item.value ? "active" : ""} onClick={() => setIconType(item.value)}>{item.label}</button>)}</div>
          </div>
          {iconType === "emoji" && <input className="project-emoji-input" aria-label="Emoji" value={iconEmoji} onChange={e => setIconEmoji(e.target.value)} placeholder="🚀" maxLength={64} />}
          {iconType === "icon" && <ProjectIconPicker value={iconName} onChange={setIconName} />}
          {iconType === "image" && <div className="project-file-field">
            <button type="button" className="ghost-button compact" onClick={() => fileInput.current?.click()}><ImageUp size={14} />{iconFile || (project.iconType === "image" && project.iconUrl) ? "Replace image" : "Choose image"}</button>
            {iconFile && <span className="project-file-name" title={iconFile.name}>{iconFile.name}</span>}
            <input ref={fileInput} type="file" accept="image/*" hidden aria-label="Project icon image" onChange={e => { setIconFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          </div>}
        </div>
        <label>Name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100} /></label>
        <label>Description<textarea value={description} onChange={e => setDescription(e.target.value)} rows={4} /></label>
        <div className="project-settings-actions">
          {error && <p className="notice danger" role="alert">{error}</p>}
          <button className="primary-button compact" disabled={busy || !dirty}>{busy && <Loader2 className="spin" size={13} />}{saved && !dirty ? "Saved" : "Save"}</button>
        </div>
      </form>
    </section>
    <section className="project-settings-section" aria-labelledby="project-settings-members">
      <h2 id="project-settings-members">Members</h2>
      <ProjectMembers projectId={project._id} sessionToken={sessionToken} />
    </section>
    <section className="project-settings-section project-settings-danger" aria-label="Project status">
      <div className="project-danger-row">
        <strong>{project.status === "active" ? "Deactivate project" : "Project is inactive"}</strong>
        {project.status === "active"
          ? <ConfirmButton className="ghost-button compact danger" label="Deactivate project" text="Deactivate" confirmLabel="Confirm" icon={<Power size={14} />} onConfirm={() => setStatus("inactive")} />
          : <button type="button" className="ghost-button compact" onClick={() => void setStatus("active")}>Reactivate</button>}
      </div>
      {statusError && <p className="notice danger" role="alert">{statusError}</p>}
    </section>
  </div>;
}
