"use client";
import { errorText } from "@/lib/error-text";

import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { ProjectWorkspace } from "./project-workspace";
import { ChatView, CommandMenu, CreateWorkspaceDialog, InboxView, IssueComposer, IssueRouteView, MemberProfile, ShortcutsDialog, TaskModal, VoiceChatView, WorkspaceSettings, preloadViews } from "./lazy-views";
import type { CommandIssue, CommandPage } from "./command-menu";
import { IssueNavigationContext, focusedIssue, type IssueNavigation } from "./issue-navigation";
import { WorkspaceLabelsContext } from "./issue-labels";
import { showIssueToast } from "./issue-shared";
import { issuePath, legacyIssueParams, parseIssuePath, type IssueRoute } from "@/lib/issue-route";
import { useLocalVoiceParticipants } from "./use-voice-participants";
import { taskKey } from "../lib/project-issues";
import clsx from "clsx";
import { FolderPlus, Check, ChevronDown, ChevronRight, CircleDot, CircleAlert, ImageUp, Inbox, Loader2, LogOut, Menu, MessageCircle, PenTool, Plus, Search, Settings2, PanelLeftClose, PanelLeftOpen, SquarePen, Video, X, type LucideIcon } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { MemberProfileContext, useMemberProfile, useWorkspace, type Workspace } from "./workspace-context";
import { useModalKeyboard } from "./use-modal-keyboard";
import { useAnchoredPopover } from "./use-anchored-popover";
import { WorkspaceGitHubSetup } from "./repository-settings";
import { useNotifications } from "./use-notifications";
import { ProjectIcon } from "./project-icon";
import { ProjectSortMenu } from "./project-sort-menu";
import { projectSortOptions, sortProjects, type ProjectSort } from "@/lib/project-sort";
import { useProjectPresence } from "./use-project-presence";
import { Dialog } from "./dialog";
import { MotionLayer } from "./motion-layer";
import { ErrorBoundary } from "./error-boundary";
import { FormStatus, type FormNotice } from "./settings-controls";
import { UserAvatar, memberName } from "./user-avatar";
import { ContentSkeleton } from "./content-skeleton";
import { DrawView } from "./draw-view";
import { SidebarResizeHandle } from "./sidebar-resize-handle";
import { useSidebarLayout } from "./use-sidebar-layout";
import { focusInitialInput, focusQuietly } from "@/lib/initial-focus";
import { swallowPressClick } from "@/lib/outside-press";
import { hasOpenKeyboardOverlay, isEditingTarget, issueActionShortcut, workspaceShortcut } from "@/lib/keyboard-navigation";
import { rankSearchResults } from "@/lib/search-ranking";
import { localApi as requestLocalApi } from "@/lib/client-api";


export type AuthUser = {
  _id: Id<"users">;
  name: string;
  username?: string;
  email: string;
  avatarUrl?: string | null;
  createdAt?: number;
  role: "owner" | "user";
  status: "active" | "disabled";
};
type ToolView = "inbox" | "chat" | "voice" | "draw";
type MainView = "project" | "issue" | ToolView;
const toolViews: readonly string[] = ["inbox", "chat", "voice", "draw"] satisfies ToolView[];
const toolView = (value: string | null) => value && toolViews.includes(value) ? value as ToolView : null;
type ProjectWithUi = Doc<"projects"> & { memberRole: string; iconUrl?: string | null; openIssueCount?: number };
type LocalChatMessage = {
  id: string;
  authorUserId: Id<"users">;
  authorName: string;
  authorEmail: string;
  avatarUrl?: string | null;
  body: string;
  createdAt: number;
};

function orderSidebarProjects(projects: ProjectWithUi[]) {
  return [...projects].sort((a, b) => {
    if (a.order !== undefined || b.order !== undefined) return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    return a.name.localeCompare(b.name);
  });
}
function LoadingState({ label = "Loading" }: { label?: string }) {
  return <ContentSkeleton label={label} kind={label.includes("board") || label.includes("project") ? "board" : "list"} rows={4} />;
}
function EmptyBlock({ icon: Icon, title, body }: { icon: LucideIcon; title: string; body: string }) {
  return (
    <div className="empty-block">
      <Icon size={22} />
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}




export function OriginWorkspace({ sessionToken, user, workspaces, onLogout }: { sessionToken: string; user: AuthUser; workspaces: Workspace[]; onLogout: () => void }) {
  const workspace = useWorkspace();
  const [activeProjectId, setActiveProjectId] = useState<Id<"projects"> | null>(null);
  // An issue page URL (/{workspace}/issue/ORI-1A2B/<id>) opens straight on the issue.
  const [issueRoute, setIssueRoute] = useState<IssueRoute | null>(() => typeof window === "undefined" ? null : parseIssuePath(window.location.pathname));
  const [mainView, setMainView] = useState<MainView>(() => issueRoute ? "issue" : "project");
  const [command, setCommand] = useState<{ page: CommandPage; issue: CommandIssue | null } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const returnFocus = useRef<{ projectId: Id<"projects">; taskId: Id<"tasks"> } | null>(null);
  const [visitedTools, setVisitedTools] = useState({ draw: false, voice: false });
  const [sidebarLayout, setSidebarLayout] = useSidebarLayout(user._id);
  const sidebarCollapsed = sidebarLayout.collapsed;
  const setSidebarCollapsed = (collapsed: boolean) => setSidebarLayout(current => ({ ...current, collapsed }));
  const [sidebarHover, setSidebarHover] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [projectGroupsOpen, setProjectGroupsOpen] = useState({ inactive: false });
  const [searchOpen, setSearchOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const drawerWasOpen = useRef(false);
  useEffect(() => {
    // The phone drawer takes focus when it opens and gives it back to the menu button when it closes.
    if (mobileOpen) focusQuietly(sidebarRef.current?.querySelector<HTMLElement>('.nav-item[aria-current="page"], .project-button[aria-current="page"], .nav-item'));
    else if (drawerWasOpen.current && navButtonRef.current?.getClientRects().length && !document.querySelector("dialog[open]")) focusQuietly(navButtonRef.current);
    drawerWasOpen.current = mobileOpen;
  }, [mobileOpen]);
  const [dragProject, setDragProject] = useState<Id<"projects"> | null>(null);
  const [projectOrder, setProjectOrder] = useState<Id<"projects">[] | null>(null);
  const [projectSort, setProjectSort] = useState<ProjectSort>("manual");
  const sortKey = `origin.project-sort.${user._id}.${workspace._id}`;
  useEffect(() => {
    try { const saved = localStorage.getItem(sortKey); setProjectSort(projectSortOptions.some(option => option.value === saved) ? saved as ProjectSort : "manual"); } catch { setProjectSort("manual"); }
  }, [sortKey]);
  const changeProjectSort = (value: ProjectSort) => {
    setProjectSort(value);
    try { localStorage.setItem(sortKey, value); } catch { /* Sorting still works with browser storage disabled. */ }
  };
  const [shellNotice, setShellNotice] = useState("");
  const [chatFocus, setChatFocus] = useState<string | undefined>();
  const notifications = useNotifications(sessionToken, workspace._id, user._id);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [memberEmail, setMemberEmail] = useState<string | null>(null);
  const [linkedTask, setLinkedTask] = useState<{ projectId: Id<"projects">; taskId: Id<"tasks"> } | null>(null);
  const [initialIssue, setInitialIssue] = useState<{ projectId: Id<"projects">; taskId: Id<"tasks"> } | null>(null);
  const reorder = useMutation(api.projects.reorder);
  const projects = useQuery(api.projects.listForUser, { sessionToken, teamId: workspace._id });
  // The composer needs a project to file into; without one the create buttons and the C shortcut stay off.
  const canCreateIssue = workspace.role !== "viewer" && Boolean(projects?.some(project => project.memberRole !== "viewer"));
  const workspaceRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = workspaceRef.current;
    // Phones would pop the keyboard over the view they just opened.
    if (!root || document.querySelector('dialog[open], [aria-modal="true"]') || matchMedia("(pointer: coarse)").matches) return;
    if (root.querySelector("[data-initial-focus]") && !root.contains(document.activeElement)) focusInitialInput(root);
  }, [mainView]);
  const voiceParticipants = useLocalVoiceParticipants(sessionToken, !!sessionToken && !!user);
  const sidebarProjects: ProjectWithUi[] | undefined = projects ? projectOrder ? [...projects].sort((a, b) => projectOrder.indexOf(a._id) - projectOrder.indexOf(b._id)) : sortProjects(orderSidebarProjects(projects), projectSort) : undefined;
  const collaborators = useProjectPresence(sessionToken, workspace._id, mainView === "project" && projects?.some(project => project._id === activeProjectId) ? activeProjectId : null);
  const projectViewers = [...collaborators.map(member => ({ ...member, self: false })),
    ...(mainView === "project" && activeProjectId ? [{ userId: user._id, projectId: activeProjectId, name: user.name, email: user.email, username: user.username, avatarUrl: user.avatarUrl || null, updatedAt: 0, self: true }] : []),
  ];
  const viewersByProject = new Map<string, typeof projectViewers>();
  for (const viewer of projectViewers) {
    const viewers = viewersByProject.get(viewer.projectId) || [];
    viewers.push(viewer);
    viewersByProject.set(viewer.projectId, viewers);
  }

  // Once the projects are in, fetch the views the board left out.
  useEffect(() => { if (projects) preloadViews(); }, [projects]);
  useEffect(() => { if (mainView === "draw" || mainView === "voice") setVisitedTools(current => ({ ...current, [mainView]: true })); }, [mainView]);

  useEffect(() => {
    localStorage.setItem("origin.workspace", workspace.slug);
    const params = new URLSearchParams(window.location.search);
    const githubStatus = params.get("github");
    if (githubStatus) setShellNotice(githubStatus === "connected" ? "GitHub connected to this workspace." : githubStatus === "app-ready" ? "GitHub App ready. Open Settings > Integrations to connect your workspace." : githubStatus === "setup-failed" ? "GitHub App setup was not completed. Try again from Settings > Integrations." : "GitHub connection was not completed. Try again from Settings > Integrations.");
    const view = toolView(params.get("view"));
    if (view) setMainView(view);
    const project = params.get("project");
    if (project) setActiveProjectId(project as Id<"projects">);
    // Links from before issue pages (?project=…&issue=…) open the page at its own URL.
    const legacy = legacyIssueParams(window.location.search);
    if (legacy && !parseIssuePath(window.location.pathname)) {
      window.history.replaceState(null, "", issuePath(workspace.slug, legacy.taskId));
      setIssueRoute(parseIssuePath(window.location.pathname));
      setMainView("issue");
    }
  }, [workspace.slug]);

  const assign = useMutation(api.tasks.updateTask);
  const canEditIssue = (issue: CommandIssue | null) => Boolean(issue && projects?.find(project => project._id === issue.projectId && project.memberRole !== "viewer"));
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => undefined);
  const handleKeys = (event: KeyboardEvent) => {
    if (event.key === "Escape") setMobileOpen(false);
    const editing = isEditingTarget(event.target) || isEditingTarget(document.activeElement);
    const overlayOpen = hasOpenKeyboardOverlay();
    const action = workspaceShortcut(event, { editing, overlayOpen, canCreate: canCreateIssue });
    if (action) {
      event.preventDefault();
      if (action === "command-menu") setCommand({ page: "root", issue: focusedIssue() });
      else if (action === "shortcuts") setShortcutsOpen(true);
      else if (action === "search") setSearchOpen(true);
      else setIssueOpen(true);
      return;
    }
    const issue = focusedIssue();
    const issueAction = issueActionShortcut(event, { editing, overlayOpen, hasIssue: Boolean(issue), canEdit: canEditIssue(issue) });
    if (!issueAction || !issue) return;
    event.preventDefault();
    if (issueAction === "assign-me") {
      void assign({ ...issue, sessionToken, assignedToEmail: user.email }).then(() => showIssueToast(`Assigned ${taskKey(issue.taskId)} to you`), error => showIssueToast(errorText(error, "Could not assign issue")));
      return;
    }
    setCommand({ page: issueAction, issue });
  };
  useEffect(() => { keyHandler.current = handleKeys; });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => keyHandler.current(event);
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, []);
  const workspaceLabels = useQuery(api.labels.list, { sessionToken, teamId: workspace._id });
  const ensureLabels = useMutation(api.labels.ensureDefaults);
  const seeded = useRef(false);
  // Store Feature, Bug and Improvement once for workspaces created before the label registry.
  useEffect(() => {
    if (seeded.current || workspace.role === "viewer" || !workspaceLabels?.labels.some(label => label._id === null)) return;
    seeded.current = true;
    void ensureLabels({ sessionToken, teamId: workspace._id }).catch(() => undefined);
  }, [workspaceLabels, workspace.role, workspace._id, sessionToken, ensureLabels]);

  useEffect(() => {
    if (projects === undefined) return;
    if (!projects.length) {
      setActiveProjectId(null);
      return;
    }
    const orderedProjects = orderSidebarProjects(projects);
    if (!activeProjectId || !orderedProjects.some((project) => project._id === activeProjectId)) {
      setActiveProjectId(orderedProjects[0]._id);
    }
  }, [projects, activeProjectId]);

  // Sidebar destinations each get a history entry, so Back (and the Android back gesture) returns to the previous
  // view. A deep link keeps its entry; re-selecting the view that is already open adds nothing.
  const shown = useRef({ mainView, activeProjectId });
  useEffect(() => { shown.current = { mainView, activeProjectId }; }, [mainView, activeProjectId]);
  useEffect(() => {
    const onPop = () => {
      const route = parseIssuePath(window.location.pathname);
      if (route?.slug === workspace.slug) { setMobileOpen(false); setIssueRoute(route); setMainView("issue"); return; }
      if (window.location.pathname !== `/${workspace.slug}`) return;
      const params = new URLSearchParams(window.location.search);
      setMobileOpen(false);
      const view = toolView(params.get("view"));
      if (view) { setMainView(view); return; }
      const project = params.get("project") as Id<"projects"> | null;
      const issue = params.get("issue") as Id<"tasks"> | null;
      // The open project's board follows its own issue and tab entries; a project coming back on screen reads them.
      if (project && (project !== shown.current.activeProjectId || shown.current.mainView !== "project")) {
        setActiveProjectId(project);
        setInitialIssue(issue ? { projectId: project, taskId: issue } : null);
      }
      setMainView("project");
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [workspace.slug]);

  const openProject = (projectId: Id<"projects">) => {
    const already = mainView === "project" && activeProjectId === projectId;
    setActiveProjectId(projectId);
    setInitialIssue(null);
    setMainView("project");
    setMobileOpen(false);
    if (!already) window.history.pushState(null, "", `/${workspace.slug}?project=${projectId}`);
  };
  /** An issue's full page: its own history entry and URL; Back (or Escape) returns to where it was opened from. */
  const openIssue = (projectId: Id<"projects">, taskId: Id<"tasks">) => {
    setLinkedTask(null); setMobileOpen(false);
    if (mainView === "project") returnFocus.current = { projectId, taskId };
    setActiveProjectId(projectId);
    setIssueRoute({ slug: workspace.slug, key: taskKey(taskId), taskId });
    setMainView("issue");
    if (window.location.pathname !== issuePath(workspace.slug, taskId)) window.history.pushState({ originIssuePage: taskId }, "", issuePath(workspace.slug, taskId));
  };
  const closeIssue = (projectId?: Id<"projects">) => {
    if (window.history.state?.originIssuePage) { window.history.back(); return; }
    if (projectId) { openProject(projectId); return; }
    setMainView("project");
    window.history.pushState(null, "", `/${workspace.slug}`);
  };
  const navigation = useMemo<IssueNavigation>(() => ({
    openIssue: (projectId, taskId) => openIssueRef.current(projectId, taskId),
    takeReturnFocus: projectId => {
      const target = returnFocus.current;
      if (target?.projectId !== projectId) return null;
      returnFocus.current = null;
      return target.taskId;
    },
  }), []);
  const openIssueRef = useRef(openIssue);
  useEffect(() => { openIssueRef.current = openIssue; });
  const openReference = (projectId: Id<"projects">, taskId?: Id<"tasks">) => { if (taskId) setLinkedTask({ projectId, taskId }); else { setLinkedTask(null); openProject(projectId); } };
  const openView = (view: ToolView) => {
    const already = mainView === view;
    setMainView(view); setMobileOpen(false);
    if (!already) window.history.pushState(null, "", `/${workspace.slug}?view=${view}`);
  };
  const moveProject = async (target: Id<"projects">) => {
    if (!dragProject || dragProject === target || !sidebarProjects) return;
    const ids = sidebarProjects.map(p => p._id).filter(id => id !== dragProject);
    ids.splice(ids.indexOf(target), 0, dragProject);
    changeProjectSort("manual"); setProjectOrder(ids); setDragProject(null);
    try { await reorder({ sessionToken, teamId: workspace._id, projectIds: ids }); }
    catch (error) { setShellNotice(errorText(error, "Could not reorder projects")); }
    finally { setProjectOrder(null); }
  };

  return (
    <MemberProfileContext.Provider value={setMemberEmail}><IssueNavigationContext.Provider value={navigation}><WorkspaceLabelsContext.Provider value={workspaceLabels}><div style={{ "--sidebar-width": `${sidebarLayout.width}px` } as CSSProperties} className={clsx("app-shell", "workspace-app", mobileOpen && "mobile-nav-open", sidebarCollapsed && "sidebar-collapsed", sidebarCollapsed && !sidebarHover && "sidebar-hidden", sidebarCollapsed && sidebarHover && "sidebar-floating")}>
      <MotionLayer />
      <header className="mobile-topbar" inert={mobileOpen || undefined}><button ref={navButtonRef} className="icon-button" aria-label="Open navigation" aria-expanded={mobileOpen} aria-controls="workspace-sidebar" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><strong className="mobile-project-name">{mainView === "project" || mainView === "issue" ? projects?.find(project => project._id === activeProjectId)?.name ?? (projects?.length === 0 ? workspace.name : null) : { inbox: "Inbox", chat: "Chat", voice: "Call", draw: "Draw" }[mainView]}</strong>{canCreateIssue && mainView !== "project" && <button className="icon-button" aria-label="Create issue" onClick={() => setIssueOpen(true)}><SquarePen size={18} /></button>}</header>
      {mobileOpen && <button className="mobile-nav-scrim" aria-label="Close navigation" tabIndex={-1} onClick={() => setMobileOpen(false)} />}
      {sidebarCollapsed ? <div className="sidebar-hover-zone" onMouseEnter={() => setSidebarHover(true)} /> : null}
      <aside ref={sidebarRef} id="workspace-sidebar" className="sidebar" aria-label="Workspace" onMouseLeave={() => { if (sidebarCollapsed) setSidebarHover(false); }}>
        <div className="sidebar-topbar">
          <ProfileMenu user={user} sessionToken={sessionToken} onLogout={onLogout} sound={notifications.sound} onToggleSound={notifications.toggleSound} workspaces={workspaces} onCreateWorkspace={() => { setMobileOpen(false); setCreateWorkspaceOpen(true); }} onOpenSettings={() => setMobileOpen(false)} onCollapse={() => { setSidebarCollapsed(!sidebarCollapsed); setSidebarHover(false); }} />
          <button className="icon-button" type="button" onClick={() => setSearchOpen(true)} aria-label="Search" title="Search (/) · Commands (⌘K)" aria-keyshortcuts="/ f">
            <Search size={17} />
          </button>
          <button className="icon-button sidebar-new-issue" title="Create issue (C)" aria-label="Create issue" aria-keyshortcuts="C" disabled={!canCreateIssue} onClick={() => setIssueOpen(true)}><SquarePen size={17} /></button>
        </div>
        <div className="sidebar-content">
          <span className="nav-glider" aria-hidden="true"><span className="nav-glider-avatar"><UserAvatar user={user} size="small" /></span></span>
          <nav className="sidebar-nav">
          <button
            aria-current={mainView === "inbox" ? "page" : undefined} className={clsx("nav-item", mainView === "inbox" && "active")}
            type="button"
            onClick={() => openView("inbox")}
          >
            <Inbox size={16} />
            <span>Inbox</span>
            {(notifications.summary?.unread || 0) > 0 && <small className="nav-unread" aria-label={`${notifications.summary!.unread}${notifications.summary!.more ? "+" : ""} unread notifications`}>{notifications.summary!.unread}{notifications.summary!.more ? "+" : ""}</small>}
          </button>
          <button aria-current={mainView === "chat" ? "page" : undefined} className={clsx("nav-item", mainView === "chat" && "active")} type="button" onClick={() => openView("chat")}>
            <MessageCircle size={16} />
            <span>Chat</span>
          </button>
          <button aria-current={mainView === "voice" ? "page" : undefined} className={clsx("nav-item", mainView === "voice" && "active")} type="button" onClick={() => openView("voice")}>
            <Video size={16} />
            <span>Call</span>
            {(voiceParticipants?.length || 0) > 0 && <small className="nav-live" aria-label={`${voiceParticipants!.length} in call`}>{voiceParticipants!.length}</small>}
          </button>
          <button aria-current={mainView === "draw" ? "page" : undefined} className={clsx("nav-item", mainView === "draw" && "active")} type="button" onClick={() => openView("draw")}><PenTool size={16} /><span>Draw</span></button>
          </nav>
          <div className="sidebar-section">
            <div className="sidebar-section-head">
              <button className="section-toggle" type="button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((value) => !value)}>
                {projectsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>Projects</span>
              </button>
              {(projects?.length ?? 0) > 1 && <ProjectSortMenu value={projectSort} onChange={changeProjectSort} />}
              <CreateProjectInline sessionToken={sessionToken} onCreated={openProject} iconOnly />
            </div>
            {projects === undefined ? <LoadingState label="Projects" /> : null}
              {projectsOpen && <div className="sidebar-project-list">
                {(["active", "inactive"] as const).map(group => <div className="sidebar-project-group" key={group}>
                {group !== "active" && sidebarProjects?.some(project => project.status !== "active") && <button className="section-toggle project-group-toggle" aria-expanded={projectGroupsOpen[group]} onClick={() => setProjectGroupsOpen(current => ({ ...current, [group]: !current[group] }))}>{projectGroupsOpen[group] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span>Inactive</span><small>{sidebarProjects?.filter(project => project.status !== "active").length || 0}</small></button>}
                {(group === "active" ? projectsOpen : projectGroupsOpen[group]) && sidebarProjects?.filter(project => group === "active" ? project.status === "active" : project.status !== "active").map((project) => {
                  const viewers = (viewersByProject.get(project._id) || []).sort((a, b) => Number(b.self) - Number(a.self));
                  return (
                  <button
                    key={project._id}
                    data-project-id={project._id}
                    aria-current={(mainView === "project" || mainView === "issue") && activeProjectId === project._id ? "page" : undefined} className={clsx("project-button", dragProject === project._id && "dragging", (mainView === "project" || mainView === "issue") && activeProjectId === project._id && "active")}
                    type="button"
                    draggable={workspace.role !== "viewer"}
                    onDragStart={event => { setDragProject(project._id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", project._id); }}
                    onDragOver={event => { if (dragProject) event.preventDefault(); }}
                    onDrop={event => { event.preventDefault(); void moveProject(project._id); }}
                    onDragEnd={() => setDragProject(null)}
                    onKeyDown={event => { if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key) && workspace.role !== "viewer") { event.preventDefault(); const ids = sidebarProjects.map(p => p._id); const at = ids.indexOf(project._id); const target = at + (event.key === "ArrowUp" ? -1 : 1); if (target >= 0 && target < ids.length) { [ids[at], ids[target]] = [ids[target], ids[at]]; changeProjectSort("manual"); void reorder({ sessionToken, teamId: workspace._id, projectIds: ids }).catch(error => setShellNotice(errorText(error, "Could not reorder projects"))); } } }}
                    onClick={() => openProject(project._id)}
                  >
                    <ProjectIcon project={project} />
                    <span className="sidebar-project-name">{project.name}</span>
                    <span className="project-trailing"><span className="project-viewers" title={viewers.length ? `${viewers.map(member => member.self ? "You" : member.name).join(", ")} viewing this project` : undefined}>
                      {viewers.slice(0, 2).map(member => <span key={member.userId} className="project-viewer" data-self-viewer={member.self || undefined} aria-label={member.self ? "You are viewing this project" : `${member.name} is viewing this project`}><UserAvatar user={member} size="small" /></span>)}
                      {viewers.length > 2 && <span className="project-viewer viewer-overflow">+{viewers.length - 2}</span>}
                    </span>{(project.openIssueCount ?? 0) > 0 && <small className="project-issue-count" aria-label={`${project.openIssueCount} open issues`}>{project.openIssueCount}</small>}</span>
                  </button>
                ); })}</div>)}
              </div>}
          </div>
        </div>
      </aside>
      {!sidebarCollapsed && <SidebarResizeHandle width={sidebarLayout.width} onResize={width => setSidebarLayout(current => ({ ...current, width }))} onCollapse={width => { setSidebarLayout({ width, collapsed: true }); setSidebarHover(false); }} />}
      <main ref={workspaceRef} inert={mobileOpen || undefined} className={clsx("workspace", mainView === "draw" && "draw-workspace")}>
        {sidebarCollapsed && <button className="icon-button sidebar-restore" aria-label="Keep sidebar open" title="Keep sidebar open" aria-controls="workspace-sidebar" aria-expanded="false" onClick={() => { setSidebarCollapsed(false); setSidebarHover(false); }}><PanelLeftOpen size={18} /></button>}
        {shellNotice && <div className="notice danger">{shellNotice}<button className="icon-button" aria-label="Dismiss" onClick={() => setShellNotice("")}><X size={14} /></button></div>}
        <ErrorBoundary resetKey={`${mainView}:${activeProjectId}:${issueRoute?.taskId ?? issueRoute?.key ?? ""}`} fallback={<EmptyBlock icon={CircleAlert} title="This view could not load" body="It may have been deleted or your access changed." />}>
        {mainView === "issue" && issueRoute ? (
          <IssueRouteView route={issueRoute} sessionToken={sessionToken} projects={projects} onResolved={setActiveProjectId} onBack={closeIssue} onOpenProject={openProject} onOpenReference={(projectId, taskId) => { if (taskId) openIssue(projectId, taskId); else openProject(projectId); }} onOpenIssue={openIssue} />
        ) : mainView === "chat" ? (
          <ChatView sessionToken={sessionToken} user={user} focusMessageId={chatFocus} onOpenReference={openReference} />
        ) : mainView === "draw" || mainView === "voice" ? null
        : mainView === "inbox" ? (
          <InboxView sessionToken={sessionToken} unread={notifications.summary?.unread || 0} onOpenProject={openProject} onOpenChat={messageId => { setChatFocus(messageId); openView("chat"); }} onOpenTask={openIssue} />
        ) : activeProjectId ? (
          <ProjectWorkspace key={activeProjectId} projectId={activeProjectId} sessionToken={sessionToken} user={user} viewers={projectViewers.filter(v => v.projectId === activeProjectId)} initialTaskId={initialIssue?.projectId === activeProjectId ? initialIssue.taskId : undefined} onOpenReference={(projectId, taskId) => { if (taskId) openIssue(projectId, taskId); else openProject(projectId); }} />
        ) : (
          <EmptyProjects sessionToken={sessionToken} onCreated={openProject} />
        )}
        </ErrorBoundary>
        {visitedTools.draw && <div className="persistent-tool draw-tool" hidden={mainView !== "draw"}><DrawView sessionToken={sessionToken} user={user} /></div>}
        {visitedTools.voice && <div className="persistent-tool voice-tool" hidden={mainView !== "voice"}><VoiceChatView sessionToken={sessionToken} user={user} /></div>}
      </main>
      {issueOpen && <IssueComposer sessionToken={sessionToken} activeProjectId={mainView === "project" ? activeProjectId : null} projects={sidebarProjects || []} onClose={() => setIssueOpen(false)} onCreated={openProject} />}
      {createWorkspaceOpen && <CreateWorkspaceDialog sessionToken={sessionToken} onClose={() => setCreateWorkspaceOpen(false)} />}
      {memberEmail && <MemberProfile key={memberEmail} email={memberEmail} sessionToken={sessionToken} onClose={() => setMemberEmail(null)} onOpenIssue={openIssue} />}
      {linkedTask && projects?.find(p => p._id === linkedTask.projectId) && <TaskModal project={projects.find(p => p._id === linkedTask.projectId)!} projectId={linkedTask.projectId} taskId={linkedTask.taskId} sessionToken={sessionToken} canEdit={projects.find(p => p._id === linkedTask.projectId)!.memberRole !== "viewer"} onClose={() => setLinkedTask(null)} onOpenReference={openReference} onOpenPage={() => openIssue(linkedTask.projectId, linkedTask.taskId)} />}
      {command && <CommandMenu key={`${command.page}:${command.issue?.taskId ?? ""}`} sessionToken={sessionToken} issue={command.issue} initialPage={command.page} canEdit={canEditIssue(command.issue)} onClose={() => setCommand(null)}
        onCreateIssue={canCreateIssue ? () => setIssueOpen(true) : undefined} onSearch={() => setSearchOpen(true)} onShortcuts={() => setShortcutsOpen(true)} onOpenInbox={() => openView("inbox")} onOpenChat={() => openView("chat")} onOpenIssue={openIssue} />}
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
      {searchOpen ? (
        <SearchDialog
          activeProjectId={activeProjectId}
          projects={sidebarProjects ?? []}
          sessionToken={sessionToken}
          onClose={() => setSearchOpen(false)}
          onOpenProject={openProject}
          onOpenChat={messageId => { setChatFocus(messageId); openView("chat"); }}
          onOpenTask={openIssue}
        />
      ) : null}
    </div></WorkspaceLabelsContext.Provider></IssueNavigationContext.Provider></MemberProfileContext.Provider>
  );
}


function ProfileMenu({
  user,
  sessionToken,
  onLogout,
  sound,
  onToggleSound,
  workspaces,
  onCreateWorkspace,
  onCollapse,
  onOpenSettings,
}: {
  user: AuthUser;
  sessionToken: string;
  onLogout: () => void;
  sound: boolean;
  onToggleSound: () => void;
  workspaces: Workspace[];
  onCreateWorkspace: () => void;
  onCollapse: () => void;
  /** Settings opens over everything, so the phone drawer closes first. */
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<false | "first" | "last">(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const workspace = useWorkspace();
  // Switching stays in the app: the workspace view remounts for the new workspace without a page load.
  const router = useRouter();
  const items = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') || [])];
  const closeMenu = (refocus = true) => { setMenu(false); if (refocus) focusQuietly(triggerRef.current); };
  // Under the chip on desktop, a bottom sheet on phones like every other menu.
  const noInitialFocus = useRef<HTMLElement>(null);
  useAnchoredPopover(Boolean(menu), triggerRef, listRef, noInitialFocus, { width: 240, maxHeight: 520, onDismiss: restore => {
    // A press outside only closes the menu; it does not also open what was under it.
    if (!restore) swallowPressClick();
    closeMenu(restore);
  } });
  useEffect(() => {
    if (!menu) return;
    const list = items();
    focusQuietly(menu === "last" ? list.at(-1) : list[0]);
  }, [menu]);
  const choose = (action: () => void) => { closeMenu(); action(); };
  return (
    <div className="profile-menu-wrap">
      {open ? <WorkspaceSettings sessionToken={sessionToken} sound={sound} onToggleSound={onToggleSound} profile={<ProfileSettings user={user} sessionToken={sessionToken} />} security={<PasswordChanger sessionToken={sessionToken} />} onClose={() => setOpen(false)} onLogout={onLogout} /> : null}
      <button ref={triggerRef} className="profile-chip bottom" type="button" aria-label={`${workspace.name}, account menu`} aria-expanded={Boolean(menu)} aria-haspopup="menu" aria-controls={menu ? "account-menu" : undefined} onClick={() => setMenu(menu ? false : "first")} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setMenu(event.key === "ArrowUp" ? "last" : "first"); }
      }}>
        <span className="workspace-initial" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span>
        <strong>{workspace.name}</strong>
        <ChevronDown className="profile-chevron" size={13} />
      </button>
      {menu && <div ref={listRef} id="account-menu" popover="manual" className="origin-dropdown account-dropdown" role="menu" aria-label="Account and workspaces" onKeyDown={event => {
        const list = items();
        const index = list.indexOf(document.activeElement as HTMLElement);
        const move = (next: number) => { event.preventDefault(); list[(next + list.length) % list.length]?.focus(); };
        if (event.key === "ArrowDown") move(index + 1);
        else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(list.length - 1);
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
        else if (event.key === "Tab") setMenu(false);
        else if (event.key.length === 1 && /\S/.test(event.key)) {
          const start = index + 1;
          const match = [...list.slice(start), ...list.slice(0, start)].find(item => item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()));
          if (match) { event.preventDefault(); match.focus(); }
        }
      }}>
        <div className="account-identity"><UserAvatar user={user} size="small" /><span><strong>{memberName(user)}</strong><small>{user.email}</small></span></div>
        <hr />
        <span className="dropdown-caption" id="account-menu-workspaces">Workspaces</span>
        <div role="group" aria-labelledby="account-menu-workspaces">
          {workspaces.map(item => <button role="menuitemradio" aria-checked={item._id === workspace._id} tabIndex={-1} key={item._id} onClick={() => choose(() => { if (item._id !== workspace._id) router.push(`/${item.slug}`); })}><span className="workspace-initial" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span>{item.name}</span>{item._id === workspace._id && <Check size={14} className="menu-check" />}</button>)}
        </div>
        <button role="menuitem" tabIndex={-1} onClick={() => choose(onCreateWorkspace)}><Plus size={15} /><span>Create workspace</span></button>
        <hr />
        <button role="menuitem" tabIndex={-1} onClick={() => choose(() => { onOpenSettings(); setOpen(true); })}><Settings2 size={15} /><span>Settings</span></button>
        <button role="menuitem" tabIndex={-1} className="menu-desktop-only" onClick={() => choose(onCollapse)}><PanelLeftClose size={15} /><span>Collapse sidebar</span></button>
        <hr />
        <button role="menuitem" tabIndex={-1} onClick={() => choose(onLogout)}><LogOut size={15} /><span>Sign out</span></button>
      </div>}
    </div>
  );
}

function ProfileSettings({ user, sessionToken }: { user: AuthUser; sessionToken: string }) {
  const updateProfile = useMutation(api.auth.updateProfile);
  const generateAvatarUploadUrl = useMutation(api.auth.generateAvatarUploadUrl);
  const savedUsername = user.username || user.email.split("@")[0] || "";
  const [username, setUsername] = useState(savedUsername);
  const [name, setName] = useState(user.name || "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [notice, setNotice] = useState<FormNotice>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setUsername(user.username || user.email.split("@")[0] || "");
    setName(user.name || "");
  }, [user.email, user.name, user.username]);
  useEffect(() => {
    if (!avatarFile) { setPreview(""); return; }
    const url = URL.createObjectURL(avatarFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [avatarFile]);
  const dirty = name.trim() !== (user.name || "") || username.trim() !== savedUsername || Boolean(avatarFile);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      let avatarStorageId: Id<"_storage"> | undefined;
      if (avatarFile) {
        const uploadUrl = await generateAvatarUploadUrl({ sessionToken });
        const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": avatarFile.type || "application/octet-stream" }, body: avatarFile });
        if (!res.ok) throw new Error("Photo upload failed");
        const payload = (await res.json()) as { storageId: Id<"_storage"> };
        avatarStorageId = payload.storageId;
      }
      await updateProfile({ sessionToken, username, name, ...(avatarStorageId ? { avatarStorageId } : {}) });
      setAvatarFile(null);
      setNotice({ tone: "success", text: "Profile updated" });
    } catch (error) {
      setNotice({ tone: "danger", text: errorText(error, "Profile update failed") });
    } finally { setBusy(false); }
  };
  return (
    <form className="settings-form" onSubmit={submit}>
      <div className="settings-avatar-row">
        <UserAvatar user={{ ...user, avatarUrl: preview || user.avatarUrl }} className="settings-avatar" />
        <span className="settings-identity"><strong>{memberName({ ...user, name })}</strong><small>{user.email}</small></span>
        <label className="ghost-button compact file-button">
          <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp,image/gif" onChange={event => {
            const file = event.target.files?.[0] ?? null;
            event.target.value = "";
            if (file && (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 5 * 1024 * 1024)) { setNotice({ tone: "danger", text: "Choose a PNG, JPEG, WebP or GIF under 5 MB" }); return; }
            setNotice(null); setAvatarFile(file);
          }} />
          <ImageUp size={14} />{user.avatarUrl || preview ? "Change photo" : "Upload photo"}
        </label>
      </div>
      <label>Name<input value={name} onChange={event => setName(event.target.value)} autoComplete="name" maxLength={100} /></label>
      <label>Username<span className="prefixed-input"><span aria-hidden="true">@</span><input value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" spellCheck={false} /></span></label>
      <FormStatus notice={notice} />
      <div className="settings-actions"><button className="primary-button compact" type="submit" disabled={busy || !dirty}>{busy && <Loader2 className="spin" size={14} />}Save</button></div>
    </form>
  );
}

function PasswordChanger({ sessionToken }: { sessionToken: string }) {
  const changePassword = useMutation(api.auth.changePassword);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [notice, setNotice] = useState<FormNotice>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice(null);
    try {
      await changePassword({ sessionToken, currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setNotice({ tone: "success", text: "Password changed" });
    } catch (error) { setNotice({ tone: "danger", text: errorText(error, "Password change failed") }); }
    finally { setBusy(false); }
  };
  return <form className="settings-form" onSubmit={submit}>
    <h4>Password</h4>
    <label>Current password<input value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} type="password" autoComplete="current-password" required maxLength={128} /></label>
    <label>New password<input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" autoComplete="new-password" required minLength={10} maxLength={128} placeholder="At least 10 characters" /></label>
    <FormStatus notice={notice} />
    <div className="settings-actions"><button className="primary-button compact" type="submit" disabled={busy || !currentPassword || newPassword.length < 10}>{busy && <Loader2 className="spin" size={14} />}Change password</button></div>
  </form>;
}

function CreateProjectInline({ sessionToken, onCreated, iconOnly = false }: { sessionToken: string; onCreated: (id: Id<"projects">) => void; iconOnly?: boolean }) {
  const workspace = useWorkspace();
  const createProject = useMutation(api.projects.create);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const github = useQuery(api.integrations.status, open ? { sessionToken, teamId: workspace._id } : "skip");
  const [chosenRepoMode, setRepoMode] = useState<"create" | "existing" | "later" | null>(null);
  // Without a connected GitHub account a "create" request would only sit pending, so default to no repository.
  const repoMode = chosenRepoMode ?? (github?.login && github.autoCreate ? "create" : "later");
  const [repoUrl, setRepoUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      const id = await createProject({ name, sessionToken, teamId: workspace._id, repoUrl: repoMode === "existing" ? repoUrl : undefined, ...(repoMode === "later" ? { githubRepo: "later" as const } : {}) });
      setName("");
      setRepoUrl("");
      setRepoMode(null);
      setOpen(false);
      onCreated(id);
    } catch (err) {
      setError(errorText(err, "Project creation failed"));
    } finally {
      setBusy(false);
    }
  };
  return <><button className={iconOnly ? "ghost-button icon-create" : "primary-button"} type="button" aria-label={iconOnly ? "Create project" : undefined} title={iconOnly ? "Create project" : undefined} disabled={workspace.role === "viewer"} onClick={() => setOpen(true)}><Plus size={14} strokeWidth={iconOnly ? 1.5 : 2} />{iconOnly ? null : "New project"}</button>{open && <Dialog title="New project" onClose={() => setOpen(false)}><form className="dialog-body stack-form" onSubmit={submit}><label>Project name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project name" autoFocus required maxLength={100} /></label><fieldset className="repo-choice"><legend>Repository</legend><label><input type="radio" name="repository-mode" checked={repoMode === "create"} onChange={() => setRepoMode("create")} />Create a private repository</label><label><input type="radio" name="repository-mode" checked={repoMode === "existing"} onChange={() => setRepoMode("existing")} />Link an existing repository</label><label><input type="radio" name="repository-mode" checked={repoMode === "later"} onChange={() => setRepoMode("later")} />No repository</label></fieldset>{repoMode === "existing" && <label>GitHub repository<input value={repoUrl} onChange={event => setRepoUrl(event.target.value)} placeholder="owner/repository" required /></label>}{repoMode !== "later" && <WorkspaceGitHubSetup sessionToken={sessionToken} />}{error ? <div className="notice danger" role="alert">{error}</div> : null}<div className="dialog-actions"><button className="ghost-button compact" type="button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button compact" type="submit" disabled={busy || !name.trim()}>{busy && <Loader2 size={14} className="spin" />}Create project</button></div></form></Dialog>}</>;
}


function EmptyProjects({ sessionToken, onCreated }: { sessionToken: string; onCreated: (id: Id<"projects">) => void }) {
  const workspace = useWorkspace();
  return <section className="empty-projects"><FolderPlus size={22} /><h1>No projects</h1>{workspace.role !== "viewer" ? <div className="empty-create"><CreateProjectInline sessionToken={sessionToken} onCreated={onCreated} /></div> : <p>A workspace admin can add you to a project.</p>}</section>;
}

function SearchDialog({
  activeProjectId,
  projects,
  sessionToken,
  onClose,
  onOpenProject,
  onOpenTask,
  onOpenChat,
}: {
  activeProjectId: Id<"projects"> | null;
  projects: ProjectWithUi[];
  sessionToken: string;
  onClose: () => void;
  onOpenProject: (id: Id<"projects">) => void;
  onOpenTask: (projectId: Id<"projects">, taskId: Id<"tasks">) => void;
  onOpenChat: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const modalRef = useRef<HTMLElement>(null);
  useModalKeyboard(modalRef, onClose);
  const workspace = useWorkspace();
  const openMember = useMemberProfile();
  const issueResults = useQuery(api.workspaceSearch.issues, { sessionToken, teamId: workspace._id, text: query });
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [chatSearchError, setChatSearchError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setMessages([]); setChatSearchError("");
    if (query.trim().length < 2) return () => controller.abort();
    const timer = setTimeout(() => {
      void requestLocalApi<{ messages: LocalChatMessage[] }>(`/api/local-chat/messages?teamId=${workspace._id}&search=${encodeURIComponent(query)}`, sessionToken, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) setMessages(result.messages.slice(-8).reverse()); }).catch(() => { if (!controller.signal.aborted) setChatSearchError("Chat search is unavailable"); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, sessionToken, workspace._id]);
  const members = useQuery(api.workspaces.members, { teamId: workspace._id, sessionToken });
  const value = query.trim().toLowerCase();
  const projectResults = value ? projects.filter((project) => project.name.toLowerCase().includes(value)) : projects.slice(0, 5);
  const memberResults = value ? members?.filter((member) => `${member.name} ${member.username || ""} ${member.email}`.toLowerCase().includes(value)).slice(0, 8) : members?.slice(0, 5);
  const results = rankSearchResults([
    ...projectResults.map(project => ({ id: `project-${project._id}`, label: project.name, kind: "Project", icon: <ProjectIcon project={project} />, open: () => { onOpenProject(project._id); onClose(); } })),
    ...(issueResults || []).slice(0, 10).map(task => ({ id: `issue-${task._id}`, label: task.title, kind: taskKey(task._id), icon: <CircleDot size={16} />, open: () => { onOpenTask(task.projectId, task._id); onClose(); } })),
    ...(memberResults || []).map(member => ({ id: `member-${member._id}`, label: memberName(member), kind: member.username ? `@${member.username}` : "Teammate", icon: <UserAvatar user={member} size="small" />, open: () => { onClose(); openMember(member.email); } })),
    ...messages.map(message => ({ id: `chat-${message.id}`, label: message.body.slice(0, 180), kind: "Chat", icon: <MessageCircle size={16} />, open: () => { onOpenChat(message.id); onClose(); } })),
  ], query);
  const activeResult = results.find(result => result.id === selectedResult) || results[0];
  useEffect(() => { if (activeResult) document.getElementById(activeResult.id)?.scrollIntoView({ block: "nearest" }); }, [activeResult?.id]);
  return (
    <div className="modal-backdrop search-backdrop" onClick={onClose}>
      <section ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Search" className="search-modal" onClick={(event) => event.stopPropagation()}>
        <div className="search-input-row"><Search size={17} /><input value={query} onChange={(event) => { setQuery(event.target.value); setSelectedResult(null); }} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && activeResult) { event.preventDefault(); activeResult.open(); }
          else if (["ArrowDown", "ArrowUp"].includes(event.key) && results.length) { event.preventDefault(); const index = results.findIndex(result => result.id === activeResult?.id); setSelectedResult(results[(index + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length].id); }
        }} role="combobox" aria-expanded="true" aria-controls="workspace-search-results" aria-activedescendant={activeResult?.id} placeholder="Search projects, issues, people, chat" aria-label="Search projects, issues, people, chat" maxLength={160} data-initial-focus /><button type="button" aria-label="Close search" onClick={onClose}><X size={16} /></button></div>
        <div className="search-results" id="workspace-search-results" role="listbox" aria-label="Search results">
          {results.map(result => <button id={result.id} type="button" role="option" tabIndex={-1} aria-selected={activeResult?.id === result.id} key={result.id} onClick={result.open} onMouseEnter={() => setSelectedResult(result.id)}>{result.icon}<span className="search-result-label">{result.label}</span><small>{result.kind}</small></button>)}
          {!results.length && <p className="muted">No results</p>}
          {chatSearchError && <p className="muted">{chatSearchError}</p>}
        </div>
      </section>
    </div>
  );
}
