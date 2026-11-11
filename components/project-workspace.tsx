"use client";
import { errorText } from "@/lib/error-text";
import { useMutation, useQuery } from "convex/react";
import { CircleCheck, CircleDot, ExternalLink, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, GitPullRequestClosed, ImageUp, Loader2, Power, Settings, Settings2 } from "lucide-react";
import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { localApi } from "@/lib/client-api";
import { formatRelative } from "@/lib/format";
import { normalizeProjectEmoji } from "@/lib/project-emoji";
import { BoardTab } from "./project-issues";
import { AssetsPanel, FeedbackView, IssueComposer, ProjectMembers, TaskModal, VaultPanel } from "./lazy-views";
import { RepositorySettings } from "./repository-settings";
import { ProjectIcon, ProjectIconPicker } from "./project-icon";
import { ProjectEmpty } from "./project-empty";
import { DelayedSkeleton } from "./delayed-skeleton";
import { ContentSkeleton } from "./content-skeleton";
import { ConfirmButton } from "./confirm-button";
import { useWorkspace } from "./workspace-context";
import type { AuthUser } from "./origin-app";

export type TabKey = "issues" | "assets" | "vault" | "repo" | "feedback" | "settings";
type ProjectIconType = "default" | "emoji" | "icon" | "image";
type GitHubSnapshot = {
  repo: string;
  tokenConfigured: boolean;
  commits: Array<{ sha: string; message: string; author: string; url: string; committedAt: number }>;
  commitsError: string;
  issues: Array<{ number: number; title: string; state: "open" | "closed"; url: string; author?: string; updatedAt: number }>;
  pullRequests: Array<{ number: number; title: string; state: "open" | "closed" | "merged"; url: string; author?: string; branch?: string; updatedAt: number }>;
  hosted: "origin-local";
};
type ProjectWithUi = Doc<"projects"> & { memberRole: string; iconUrl?: string | null; openIssueCount?: number };
type AvatarUser = { username?: string; name: string; email: string; avatarUrl?: string | null };

export const tabs: Array<{ key: Exclude<TabKey, "settings">; label: string }> = [
  { key: "issues", label: "Issues" },
  { key: "assets", label: "Assets" },
  { key: "vault", label: "Vault" },
  { key: "repo", label: "Repo" },
  { key: "feedback", label: "Feedback" },
];
const tabKeys: TabKey[] = [...tabs.map(item => item.key), "settings"];

/** The tab named by ?tab=, accepting the older "board" and "team" names. */
function tabFromLocation(): TabKey {
  const value = new URLSearchParams(window.location.search).get("tab");
  if (value === "board") return "issues";
  if (value === "team") return "settings";
  return tabKeys.includes(value as TabKey) ? value as TabKey : "issues";
}
function shortSha(sha: string) {
  return sha.startsWith("manual-") ? "manual" : sha.slice(0, 7);
}
function parseGitHubRepo(repoUrl?: string) {
  if (!repoUrl) return null;
  const value = repoUrl.trim();
  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/i, "") };
  const match = value.match(/github\.com[:/]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}
function githubRepoHref(repoUrl?: string) {
  const parsed = parseGitHubRepo(repoUrl);
  return parsed ? `https://github.com/${parsed.owner}/${parsed.repo}` : null;
}

// Last result per project and repository, shown at once when the Repo tab opens again while it refreshes.
const snapshotCache = new Map<string, { snapshot: GitHubSnapshot | null; error: string }>();

function useGitHubSnapshot(projectId: Id<"projects">, repoUrl: string | undefined, sessionToken: string, revision = 0) {
  const cacheKey = `${projectId}:${repoUrl || ""}`;
  const [snapshot, setSnapshot] = useState<GitHubSnapshot | null>(() => snapshotCache.get(cacheKey)?.snapshot ?? null);
  const [error, setError] = useState(() => snapshotCache.get(cacheKey)?.error ?? "");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!repoUrl) {
      setSnapshot(null);
      setError("");
      return;
    }
    let alive = true;
    setLoading(true);
    localApi<GitHubSnapshot>(`/api/github/repo?projectId=${projectId}`, sessionToken)
      .then((result) => {
        snapshotCache.set(cacheKey, { snapshot: result, error: "" });
        if (!alive) return;
        setSnapshot(result);
        setError("");
      })
      .catch((issue) => {
        const message = errorText(issue, "GitHub sync failed");
        snapshotCache.set(cacheKey, { snapshot: null, error: message });
        if (alive) {
          setSnapshot(null);
          setError(message);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cacheKey, projectId, repoUrl, sessionToken, revision]);
  return { snapshot, error, loading, settled: Boolean(snapshot || error) };
}

/**
 * Keeps the queries of tabs that were visited (or hovered) subscribed, so switching back to them renders their data
 * at once instead of a skeleton. Rendered as its own component so its updates never re-render the open tab.
 * Arguments match the tabs' own useQuery calls key for key, which is what lets Convex share the subscription.
 */
function TabWarmers({ projectId, sessionToken, teamId, warm }: { projectId: Id<"projects">; sessionToken: string; teamId: Id<"teams">; warm: ReadonlySet<TabKey> }) {
  const scope = { projectId, sessionToken };
  useQuery(api.tasks.board, warm.has("issues") ? scope : "skip");
  useQuery(api.members.people, warm.has("issues") || warm.has("settings") ? scope : "skip");
  useQuery(api.design.list, warm.has("assets") ? scope : "skip");
  useQuery(api.credentials.list, warm.has("vault") ? scope : "skip");
  useQuery(api.commits.list, warm.has("repo") ? scope : "skip");
  const portals = useQuery(api.feedback.portals, warm.has("feedback") ? { sessionToken, teamId } : "skip");
  const portal = portals?.find(item => item.projectId === projectId);
  useQuery(api.feedback.list, warm.has("feedback") && portal ? { sessionToken, teamId, portalId: portal._id } : "skip");
  return null;
}

export function ProjectWorkspace({ projectId, sessionToken, user, initialTaskId, onOpenReference }: { projectId: Id<"projects">; sessionToken: string; user: AuthUser; viewers: Array<AvatarUser & { userId: string }>; initialTaskId?: Id<"tasks">; onOpenReference: (projectId: Id<"projects">, taskId?: Id<"tasks">) => void }) {
  const workspace = useWorkspace();
  const [tab, setTab] = useState<TabKey>(() => typeof window === "undefined" ? "issues" : tabFromLocation());
  const [warm, setWarm] = useState<ReadonlySet<TabKey>>(() => new Set<TabKey>(["issues", tab]));
  const [issueOpen, setIssueOpen] = useState(false);
  const [pendingTask, setPendingTask] = useState(initialTaskId);
  const [feedbackTask, setFeedbackTask] = useState<Id<"tasks"> | null>(null);
  const project = useQuery(api.projects.get, { projectId, sessionToken });

  const warmTab = useCallback((key: TabKey) => setWarm(current => current.has(key) ? current : new Set([...current, key])), []);
  // Back and forward move between tabs of this project.
  useEffect(() => {
    const onPop = () => {
      const shown = new URLSearchParams(window.location.search).get("project");
      if (shown && shown !== projectId) return;
      const next = tabFromLocation();
      warmTab(next);
      setTab(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [projectId, warmTab]);

  const openTab = (key: TabKey) => {
    if (key === tab) return;
    warmTab(key);
    setTab(key);
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
        {tab === "assets" && <AssetsPanel projectId={projectId} sessionToken={sessionToken} canEdit={canEdit} />}
        {tab === "vault" && <VaultPanel projectId={projectId} sessionToken={sessionToken} canEdit={canEdit} />}
        {tab === "repo" && <RepoTab project={project} sessionToken={sessionToken} />}
        {tab === "feedback" && <FeedbackView key={projectId} projectId={projectId} projectName={project.name} sessionToken={sessionToken} canEdit={canEdit} onOpenTask={(_, taskId) => setFeedbackTask(taskId)} />}
        {tab === "settings" && <SettingsTab project={project} sessionToken={sessionToken} />}
      </div>
      {feedbackTask && <TaskModal project={project} projectId={projectId} sessionToken={sessionToken} taskId={feedbackTask} canEdit={canEdit} onClose={() => setFeedbackTask(null)} />}
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
  const indicator = useRef<HTMLSpanElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  // Roving tab stop: the tab that holds focus while arrowing, otherwise the open tab.
  const [focusKey, setFocusKey] = useState<TabKey | null>(null);

  const place = useCallback((animate: boolean) => {
    const list = scroller.current, bar = indicator.current;
    if (!list || !bar) return;
    const active = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!active) { bar.dataset.visible = "false"; return; }
    bar.dataset.animate = animate && bar.dataset.visible === "true" ? "true" : "false";
    bar.style.width = `${active.offsetWidth - 16}px`;
    bar.style.transform = `translateX(${active.offsetLeft + 8}px)`;
    bar.dataset.visible = "true";
  }, []);
  const measureEdges = useCallback(() => {
    const list = scroller.current;
    if (!list) return;
    const start = list.scrollLeft > 2, end = list.scrollLeft + list.clientWidth < list.scrollWidth - 2;
    setEdges(current => current.start === start && current.end === end ? current : { start, end });
  }, []);

  // Slide the indicator to the active tab and scroll it into view on narrow screens.
  useLayoutEffect(() => {
    place(true);
    const list = scroller.current;
    const active = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (list && active) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const pad = 24;
      const left = active.offsetLeft - pad, right = active.offsetLeft + active.offsetWidth + pad - list.clientWidth;
      if (list.scrollLeft > left) list.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
      else if (list.scrollLeft < right) list.scrollTo({ left: right, behavior: reduce ? "auto" : "smooth" });
    }
  }, [tab, place]);
  useEffect(() => {
    const list = scroller.current;
    if (!list) return;
    const sync = () => { place(false); measureEdges(); };
    const observer = new ResizeObserver(sync);
    observer.observe(list);
    void document.fonts?.ready.then(sync);
    list.addEventListener("scroll", measureEdges, { passive: true });
    return () => { observer.disconnect(); list.removeEventListener("scroll", measureEdges); };
  }, [place, measureEdges]);

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
        {tabs.map(item => <button key={item.key} type="button" className="project-tab" {...tabProps(item.key)}><span>{item.label}</span></button>)}
        <span ref={indicator} className="project-tab-indicator" aria-hidden="true" />
      </div>
      <button type="button" className="project-settings-tab" aria-label="Settings" title="Settings" {...tabProps("settings")}><Settings size={16} /></button>
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

function RepoTab({ project, sessionToken }: { project: Doc<"projects"> & { memberRole: string }; sessionToken: string }) {
  const savedCommits = useQuery(api.commits.list, { projectId: project._id, sessionToken });
  const [revision, setRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Where the three columns stack (narrow windows, phones), one shows at a time.
  const [shown, setShown] = useState<"commits" | "issues" | "pulls">("commits");
  const github = useGitHubSnapshot(project._id, project.repoUrl, sessionToken, revision);
  const admin = ["owner", "admin"].includes(project.memberRole);
  const commits = github.snapshot?.commits ?? savedCommits;
  const repoName = githubRepoHref(project.repoUrl)?.replace("https://github.com/", "") || project.repoUrl;
  const waiting = github.loading && !github.settled;
  const settings = settingsOpen && <RepositorySettings project={project} sessionToken={sessionToken} onClose={() => setSettingsOpen(false)} onSaved={() => setRevision(value => value + 1)} />;
  if (!project.repoUrl) {
    const creating = project.githubRepoState === "pending";
    return <section className="repo-dashboard">
      <ProjectEmpty icon={creating ? Loader2 : GitBranch} spin={creating} title={creating ? "Creating repository" : "No repository"}>
        {project.githubRepoError && <p className="notice danger" role="alert">{project.githubRepoError}</p>}
        {admin && !creating && <button className="primary-button compact" onClick={() => setSettingsOpen(true)}><GitBranch size={14} />Connect repository</button>}
      </ProjectEmpty>
      {settings}
    </section>;
  }
  return (
    <section className="repo-dashboard">
      <div className="repo-address-row">
        <a href={githubRepoHref(project.repoUrl) || project.repoUrl} target="_blank" rel="noreferrer"><GitBranch size={16} /><span>{repoName}</span><ExternalLink size={13} /></a>
        {github.loading && github.settled && <Loader2 className="spin repo-refreshing" size={14} aria-label="Refreshing" />}
        {admin && <button className="ghost-button compact" onClick={() => setSettingsOpen(true)}><Settings2 size={14} />Configure</button>}
      </div>
      {github.error && <div className="notice danger" role="alert">{github.error}</div>}
      {github.snapshot?.commitsError && <div className="notice">{github.snapshot.commitsError}</div>}
      {!github.error && <div className="segmented-control repo-switch" role="group" aria-label="Show">{([["commits", "Commits", commits?.length], ["issues", "Issues", github.snapshot?.issues.length], ["pulls", "Pull requests", github.snapshot?.pullRequests.length]] as const).map(([key, label, count]) => <button key={key} type="button" className={shown === key ? "active" : ""} aria-pressed={shown === key} onClick={() => setShown(key)}>{label}{count ? <span>{count}</span> : null}</button>)}</div>}
      <div className="repository-columns" data-columns={github.error ? 1 : 3} data-shown={github.error ? "commits" : shown}>
        <RepoColumn name="commits" icon={<GitCommitHorizontal size={15} />} title="Commits" count={commits?.length} loading={commits === undefined} empty="No commits">
          {commits?.map(commit => <a className="repository-item" key={commit.sha} href={commit.url || githubRepoHref(project.repoUrl) || undefined} target="_blank" rel="noreferrer">
            <strong>{commit.message.split("\n")[0]}</strong>
            <span className="repository-meta"><code>{shortSha(commit.sha)}</code><span>{commit.author}</span><time dateTime={new Date(commit.committedAt).toISOString()}>{formatRelative(commit.committedAt)}</time></span>
          </a>)}
        </RepoColumn>
        {!github.error && <RepoColumn name="issues" icon={<CircleDot size={15} />} title="Issues" count={github.snapshot?.issues.length} loading={waiting} empty="No issues">
          {github.snapshot?.issues.map(issue => <a className="repository-item with-state" key={issue.number} href={issue.url} target="_blank" rel="noreferrer">
            <span className={`repository-state ${issue.state}`} aria-label={issue.state}>{issue.state === "open" ? <CircleDot size={14} /> : <CircleCheck size={14} />}</span>
            <strong>{issue.title}</strong>
            <span className="repository-meta"><span>#{issue.number}</span>{issue.author && <span>{issue.author}</span>}<time dateTime={new Date(issue.updatedAt).toISOString()}>{formatRelative(issue.updatedAt)}</time></span>
          </a>)}
        </RepoColumn>}
        {!github.error && <RepoColumn name="pulls" icon={<GitPullRequest size={15} />} title="Pull requests" count={github.snapshot?.pullRequests.length} loading={waiting} empty="No pull requests">
          {github.snapshot?.pullRequests.map(pr => <a className="repository-item with-state" key={pr.number} href={pr.url} target="_blank" rel="noreferrer">
            <span className={`repository-state ${pr.state}`} aria-label={pr.state}>{pr.state === "merged" ? <GitMerge size={14} /> : pr.state === "closed" ? <GitPullRequestClosed size={14} /> : <GitPullRequest size={14} />}</span>
            <strong>{pr.title}</strong>
            <span className="repository-meta"><span>#{pr.number}</span>{pr.branch && <code>{pr.branch}</code>}<time dateTime={new Date(pr.updatedAt).toISOString()}>{formatRelative(pr.updatedAt)}</time></span>
          </a>)}
        </RepoColumn>}
      </div>
      {settings}
    </section>
  );
}

function RepoColumn({ name, icon, title, count, loading, empty, children }: { name: string; icon: ReactNode; title: string; count?: number; loading: boolean; empty: string; children: ReactNode }) {
  return <section className="repository-column" data-column={name}>
    <header>{icon}<h3>{title}</h3>{!loading && count ? <span>{count}</span> : null}</header>
    {loading ? <ContentSkeleton rows={4} label={`Loading ${title.toLowerCase()}`} /> : !count ? <p className="repository-empty">{empty}</p> : <div className="repository-items">{children}</div>}
  </section>;
}
