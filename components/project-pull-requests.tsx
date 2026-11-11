"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { GitPullRequest, Settings2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/format";
import { CHECKS, PR_ICON, REVIEW } from "./task-pull-request";
import { ProjectEmpty } from "./project-empty";
import { DelayedSkeleton } from "./delayed-skeleton";
import { RepositorySettings } from "./repository-settings";

type Segment = "open" | "merged" | "closed";
const SEGMENTS: { key: Segment; label: string }[] = [{ key: "open", label: "Open" }, { key: "merged", label: "Merged" }, { key: "closed", label: "Closed" }];
const segmentOf = (state: "draft" | "open" | "merged" | "closed"): Segment => state === "draft" ? "open" : state;

/**
 * The project's pull requests that are linked to its issues (by branch name, title or "Closes ORI-…"), with the
 * issues each one moves. The PR opens on GitHub; its issue keys open the issues here.
 */
export function ProjectPullRequests({ project, sessionToken, onOpenIssue }: { project: Doc<"projects"> & { memberRole: string }; sessionToken: string; onOpenIssue: (taskId: Id<"tasks">) => void }) {
  const data = useQuery(api.taskPRs.projectPullRequests, { sessionToken, projectId: project._id });
  const [segment, setSegment] = useState<Segment>("open");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const admin = ["owner", "admin"].includes(project.memberRole);
  if (data === undefined) return <DelayedSkeleton label="Loading pull requests" />;
  const settings = settingsOpen && <RepositorySettings project={project} sessionToken={sessionToken} onClose={() => setSettingsOpen(false)} onSaved={() => undefined} />;
  if (!data.pullRequests.length) return <section className="pull-requests">
    <ProjectEmpty icon={GitPullRequest} title="No linked pull requests">
      <p className="pull-requests-hint">{project.repoUrl ? "Push a branch named after an issue, or write “Closes ORI-…” in a pull request, to link it here." : "Connect a repository in the Repo tab to link pull requests to issues."}</p>
    </ProjectEmpty>
  </section>;
  const counts = Object.fromEntries(SEGMENTS.map(({ key }) => [key, data.pullRequests.filter(pr => segmentOf(pr.state) === key).length])) as Record<Segment, number>;
  const shown = data.pullRequests.filter(pr => segmentOf(pr.state) === segment);
  const rule = data.reviewColumn ? `Opening a linked PR moves its issues to ${data.reviewColumn}; merging moves them to ${data.doneColumn}.` : `Merging a linked PR moves its issues to ${data.doneColumn}.`;
  return <section className="pull-requests">
    <div className="library-toolbar pull-requests-toolbar">
      <div className="segmented-control" role="group" aria-label="State">{SEGMENTS.map(({ key, label }) => <button key={key} type="button" className={segment === key ? "active" : ""} aria-pressed={segment === key} onClick={() => setSegment(key)}>{label}{counts[key] ? <span>{counts[key]}</span> : null}</button>)}</div>
      <span className="pull-requests-rule">{rule}</span>
      {admin && project.repoUrl && <button type="button" className="ghost-button compact" onClick={() => setSettingsOpen(true)}><Settings2 size={14} />Configure</button>}
    </div>
    {!shown.length ? <p className="repository-empty">No {segment} pull requests</p> : <ul className="pull-request-list">{shown.map(pr => {
      const Icon = PR_ICON[pr.state];
      const active = segmentOf(pr.state) === "open";
      const facts = [pr.state === "draft" ? "draft" : "", active ? CHECKS[pr.checks] ?? "" : "", active ? REVIEW[pr.review] ?? "" : "", active && pr.mergeable === false ? "conflicts" : ""].filter(Boolean);
      return <li key={pr.url} className="pull-request-row">
        <span className={`repository-state ${pr.state}`} aria-label={pr.state}><Icon size={14} /></span>
        <div className="pull-request-main">
          <a className="pull-request-title" href={pr.url} target="_blank" rel="noreferrer">{pr.title || `Pull request #${pr.number}`}</a>
          <span className="repository-meta">
            <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>
            {pr.repository && <span>{pr.repository}</span>}
            {facts.map(fact => <span key={fact}>{fact}</span>)}
            <time dateTime={new Date(pr.updatedAt).toISOString()}>{formatRelative(pr.updatedAt)}</time>
          </span>
        </div>
        <div className="pull-request-issues">{pr.issues.map(issue => <button key={issue.taskId} type="button" className="pull-request-issue" title={`${issue.title}${issue.completesOnMerge ? "" : " · won't complete on merge"}`} onClick={() => onOpenIssue(issue.taskId)}>
          <span className={issue.done ? "issue-key is-done" : "issue-key"}>{issue.key}</span>
        </button>)}</div>
      </li>;
    })}</ul>}
    {settings}
  </section>;
}
