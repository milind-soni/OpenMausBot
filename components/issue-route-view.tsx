"use client";
import { useEffect } from "react";
import { useQuery } from "convex/react";
import { CircleDot } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { issuePath, type IssueRoute } from "@/lib/issue-route";
import { taskKey } from "@/lib/project-issues";
import { IssuePage, IssuePageMessage } from "./issue-detail";
import { LoadingState, type OpenReference, type ProjectWithUi } from "./issue-shared";
import { useWorkspace } from "./workspace-context";

/**
 * Resolves an issue page URL and shows the page. A key-only URL that names one issue is rewritten to the exact URL;
 * one that names several (keys are short) lists them to choose from.
 */
export function IssueRouteView({ route, sessionToken, projects, onResolved, onBack, onOpenProject, onOpenReference, onOpenIssue }: {
  route: IssueRoute;
  sessionToken: string;
  projects: ProjectWithUi[] | undefined;
  onResolved: (projectId: Id<"projects">) => void;
  onBack: (projectId?: Id<"projects">) => void;
  onOpenProject: (projectId: Id<"projects">) => void;
  onOpenReference: OpenReference;
  onOpenIssue: (projectId: Id<"projects">, taskId: Id<"tasks">) => void;
}) {
  const workspace = useWorkspace();
  const resolved = useQuery(api.issueRoutes.resolve, { sessionToken, teamId: workspace._id, key: route.key, ...(route.taskId ? { taskId: route.taskId } : {}) });
  const found = resolved?.status === "found" ? resolved : null;
  useEffect(() => {
    if (!found) return;
    onResolved(found.projectId);
    const canonical = issuePath(workspace.slug, found.taskId);
    if (window.location.pathname !== canonical) window.history.replaceState(window.history.state, "", canonical);
    // onResolved only syncs the sidebar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [found?.taskId, found?.projectId, workspace.slug]);
  useEffect(() => { document.title = found ? `${taskKey(found.taskId)} · Origin` : "Origin"; return () => { document.title = "Origin"; }; }, [found]);

  if (resolved === undefined || projects === undefined) return <section className="issue-page"><div className="issue-detail-loading"><LoadingState label="Opening issue" /></div></section>;
  if (resolved.status === "missing") return <IssuePageMessage title={`${route.key} not found`} body="It may have been deleted, or it is in a project you can't see." ><button type="button" className="ghost-button compact" onClick={() => onBack()}>Back to issues</button></IssuePageMessage>;
  if (resolved.status === "ambiguous") return <IssuePageMessage title={`${resolved.matches.length} issues are ${route.key}`} body="Short keys can repeat. Choose the issue you meant; its link includes the exact id.">
    <ul className="issue-key-matches">{resolved.matches.map(match => <li key={match.taskId}><button type="button" onClick={() => onOpenIssue(match.projectId, match.taskId)}><CircleDot size={14} /><span>{match.title}</span><small>{projects.find(project => project._id === match.projectId)?.name}</small></button></li>)}</ul>
  </IssuePageMessage>;
  const project = projects.find(item => item._id === resolved.projectId);
  if (!project) return <IssuePageMessage title="Issue unavailable" body="This issue's project is not in your sidebar." />;
  return <IssuePage key={resolved.taskId} project={project} projectId={resolved.projectId} taskId={resolved.taskId} sessionToken={sessionToken} canEdit={project.memberRole !== "viewer"}
    onClose={() => onBack(resolved.projectId)} onOpenProject={() => onOpenProject(resolved.projectId)} onOpenReference={onOpenReference} />;
}
