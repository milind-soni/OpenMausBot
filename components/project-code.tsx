"use client";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "convex/react";
import clsx from "clsx";
import { CircleCheck, CircleDot, ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest, Loader2, Settings2 } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { localApi } from "@/lib/client-api";
import { formatRelative } from "@/lib/format";
import { CHECKS, PR_ICON, REVIEW } from "./task-pull-request";
import { ProjectEmpty } from "./project-empty";
import { ContentSkeleton } from "./content-skeleton";
import { RepositorySettings } from "./repository-settings";
import type { CodeSection } from "@/lib/project-tabs";

type Project = Doc<"projects"> & { memberRole: string };
type PullState = "draft" | "open" | "merged" | "closed";
type GitHubSnapshot = {
  repo: string;
  tokenConfigured: boolean;
  commits: Array<{ sha: string; message: string; author: string; url: string; committedAt: number }>;
  commitsError: string;
  issues: Array<{ number: number; title: string; state: "open" | "closed"; url: string; author?: string; updatedAt: number }>;
  pullRequests: Array<{ number: number; title: string; state: "open" | "closed" | "merged"; url: string; author?: string; branch?: string; updatedAt: number }>;
  hosted: "origin-local";
};
type Segment = "open" | "merged" | "closed";
const SEGMENTS: { key: Segment; label: string }[] = [{ key: "open", label: "Open" }, { key: "merged", label: "Merged" }, { key: "closed", label: "Closed" }];
const segmentOf = (state: PullState): Segment => state === "draft" ? "open" : state;
/** One pull request row: the repository's PR, plus the Origin issues it is linked to (with checks and review). */
type PullRow = {
  url: string; number: number; title: string; state: PullState; updatedAt: number;
  repository?: string; branch?: string; author?: string | null; checks?: string; review?: string; mergeable?: boolean | null;
  issues: { taskId: Id<"tasks">; key: string; title: string; done: boolean; completesOnMerge: boolean }[];
};

export function shortSha(sha: string) {
  return sha.startsWith("manual-") ? "manual" : sha.slice(0, 7);
}
export function parseGitHubRepo(repoUrl?: string) {
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

// Last result per project and repository, shown at once when the Code tab opens again while it refreshes.
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

const urlKey = (url: string) => url.trim().replace(/\/+$/, "").toLowerCase();

/** The repository's pull requests and the linked ones (which carry checks, review and issues), one row per URL. */
type LinkedPull = Omit<PullRow, "title"> & { title: string | null };
export function mergePullRequests(linked: readonly LinkedPull[], repository: readonly GitHubSnapshot["pullRequests"][number][]): PullRow[] {
  const rows = new Map<string, PullRow>();
  for (const pr of repository) rows.set(urlKey(pr.url), { url: pr.url, number: pr.number, title: pr.title, state: pr.state, updatedAt: pr.updatedAt, branch: pr.branch, author: pr.author, issues: [] });
  for (const pr of linked) {
    const known = rows.get(urlKey(pr.url));
    rows.set(urlKey(pr.url), { ...known, ...pr, title: pr.title || known?.title || "", updatedAt: Math.max(pr.updatedAt, known?.updatedAt ?? 0) });
  }
  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Code: the project's repository in one place. Its identity and connection on top, then its pull requests (linked
 * ones show the issues they move, with checks and review), commits and GitHub issues. Replaces the separate Repo and
 * Pull requests tabs, which listed the same pull requests twice.
 */
export function ProjectCode({ project, sessionToken, initialSection = "pulls", onOpenIssue }: { project: Project; sessionToken: string; initialSection?: CodeSection; onOpenIssue: (taskId: Id<"tasks">) => void }) {
  const savedCommits = useQuery(api.commits.list, { projectId: project._id, sessionToken });
  const linked = useQuery(api.taskPRs.projectPullRequests, { sessionToken, projectId: project._id });
  const [revision, setRevision] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [section, setSection] = useState<CodeSection>(initialSection);
  const [segment, setSegment] = useState<Segment>("open");
  const github = useGitHubSnapshot(project._id, project.repoUrl, sessionToken, revision);
  const admin = ["owner", "admin"].includes(project.memberRole);
  const settings = settingsOpen && <RepositorySettings project={project} sessionToken={sessionToken} onClose={() => setSettingsOpen(false)} onSaved={() => setRevision(value => value + 1)} />;

  if (!project.repoUrl) {
    const creating = project.githubRepoState === "pending";
    return <section className="code-tab">
      <ProjectEmpty icon={creating ? Loader2 : GitBranch} spin={creating} title={creating ? "Creating repository" : "No repository connected"}>
        <p className="project-empty-hint">{creating ? "This takes a few seconds." : "Connect a GitHub repository to see its pull requests and commits here. Branches named after an issue, and “Closes ORI-…” in a pull request, link them to issues."}</p>
        {project.githubRepoError && <p className="notice danger" role="alert">{project.githubRepoError}</p>}
        {admin && !creating && <button className="primary-button compact" onClick={() => setSettingsOpen(true)}><GitBranch size={14} />Connect repository</button>}
      </ProjectEmpty>
      {settings}
    </section>;
  }

  const commits = github.snapshot?.commits ?? savedCommits;
  const repoName = githubRepoHref(project.repoUrl)?.replace("https://github.com/", "") || project.repoUrl;
  const waiting = github.loading && !github.settled;
  const pulls = mergePullRequests(linked?.pullRequests ?? [], github.snapshot?.pullRequests ?? []);
  const counts = Object.fromEntries(SEGMENTS.map(({ key }) => [key, pulls.filter(pr => segmentOf(pr.state) === key).length])) as Record<Segment, number>;
  const shownPulls = pulls.filter(pr => segmentOf(pr.state) === segment);
  const rule = !linked ? "" : linked.reviewColumn ? `Opening a linked PR moves its issues to ${linked.reviewColumn}; merging moves them to ${linked.doneColumn}.` : `Merging a linked PR moves its issues to ${linked.doneColumn}.`;
  const sections: { key: CodeSection; label: string; icon: ReactNode; count?: number }[] = [
    { key: "pulls", label: "Pull requests", icon: <GitPullRequest size={14} />, count: counts.open || undefined },
    { key: "commits", label: "Commits", icon: <GitCommitHorizontal size={14} />, count: commits?.length || undefined },
    ...(!github.error ? [{ key: "issues" as const, label: "GitHub issues", icon: <CircleDot size={14} />, count: github.snapshot?.issues.filter(issue => issue.state === "open").length || undefined }] : []),
  ];
  const current = sections.some(item => item.key === section) ? section : "pulls";

  return <section className="code-tab">
    <header className="code-repo">
      <span className="code-repo-icon" aria-hidden="true"><GitBranch size={16} /></span>
      <div className="code-repo-name">
        <a href={githubRepoHref(project.repoUrl) || project.repoUrl} target="_blank" rel="noreferrer"><span>{repoName}</span><ExternalLink size={12} /></a>
        <small>{github.error ? "Not reachable" : github.snapshot ? "Connected" : "Connecting…"}</small>
      </div>
      {github.loading && github.settled && <Loader2 className="spin code-refreshing" size={14} aria-label="Refreshing" />}
      {admin && <button className="ghost-button compact" onClick={() => setSettingsOpen(true)}><Settings2 size={14} />Configure</button>}
    </header>
    {github.error && <div className="notice danger" role="alert">{github.error}</div>}
    {github.snapshot?.commitsError && <div className="notice">{github.snapshot.commitsError}</div>}
    <div className="code-toolbar">
      <div className="code-sections" role="tablist" aria-label="Code">
        {sections.map(item => <button key={item.key} type="button" role="tab" aria-selected={current === item.key} className={clsx("code-section", current === item.key && "active")} onClick={() => setSection(item.key)}>
          {item.icon}<span>{item.label}</span>{item.count ? <small>{item.count}</small> : null}
        </button>)}
      </div>
      {current === "pulls" && <div className="segmented-control" role="group" aria-label="State">{SEGMENTS.map(({ key, label }) => <button key={key} type="button" className={segment === key ? "active" : ""} aria-pressed={segment === key} onClick={() => setSegment(key)}>{label}{counts[key] ? <span>{counts[key]}</span> : null}</button>)}</div>}
    </div>

    {current === "pulls" && <>
      {rule && <p className="code-rule">{rule}</p>}
      {linked === undefined && waiting ? <ContentSkeleton rows={4} label="Loading pull requests" />
        : !shownPulls.length ? <CodeEmpty icon={<GitPullRequest size={16} />} title={`No ${segment} pull requests`} hint={segment === "open" && !pulls.length ? "Push a branch named after an issue, or write “Closes ORI-…” in a pull request, to link it to an issue." : undefined} />
        : <ul className="code-list">{shownPulls.map(pr => {
          const Icon = PR_ICON[pr.state];
          const active = segmentOf(pr.state) === "open";
          const facts = [pr.state === "draft" ? "draft" : "", active && pr.checks ? CHECKS[pr.checks] ?? "" : "", active && pr.review ? REVIEW[pr.review] ?? "" : "", active && pr.mergeable === false ? "conflicts" : ""].filter(Boolean);
          return <li key={pr.url} className="code-row pull-request-row">
            <span className={`repository-state ${pr.state}`} aria-label={pr.state}><Icon size={14} /></span>
            <div className="code-row-main">
              <a className="code-row-title" href={pr.url} target="_blank" rel="noreferrer">{pr.title || `Pull request #${pr.number}`}</a>
              <span className="repository-meta">
                <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number}</a>
                {pr.branch && <code>{pr.branch}</code>}
                {pr.author && <span>{pr.author}</span>}
                {facts.map(fact => <span key={fact} className={clsx("code-fact", /fail|conflict|changes/.test(fact) && "is-bad", /pass|approved/.test(fact) && "is-good")}>{fact}</span>)}
              </span>
            </div>
            <div className="pull-request-issues">{pr.issues.map(issue => <button key={issue.taskId} type="button" className="pull-request-issue" title={`${issue.title}${issue.completesOnMerge ? "" : " · won't complete on merge"}`} onClick={() => onOpenIssue(issue.taskId)}>
              <span className={issue.done ? "issue-key is-done" : "issue-key"}>{issue.key}</span>
            </button>)}</div>
            <time className="code-row-time" dateTime={new Date(pr.updatedAt).toISOString()}>{formatRelative(pr.updatedAt)}</time>
          </li>;
        })}</ul>}
    </>}

    {current === "commits" && (commits === undefined ? <ContentSkeleton rows={4} label="Loading commits" />
      : !commits.length ? <CodeEmpty icon={<GitCommitHorizontal size={16} />} title="No commits yet" />
      : <ul className="code-list">{commits.map(commit => <li key={commit.sha} className="code-row">
        <span className="repository-state" aria-hidden="true"><GitCommitHorizontal size={14} /></span>
        <div className="code-row-main">
          <a className="code-row-title" href={commit.url || githubRepoHref(project.repoUrl) || undefined} target="_blank" rel="noreferrer">{commit.message.split("\n")[0]}</a>
          <span className="repository-meta"><code>{shortSha(commit.sha)}</code><span>{commit.author}</span></span>
        </div>
        <time className="code-row-time" dateTime={new Date(commit.committedAt).toISOString()}>{formatRelative(commit.committedAt)}</time>
      </li>)}</ul>)}

    {current === "issues" && (waiting ? <ContentSkeleton rows={4} label="Loading issues" />
      : !github.snapshot?.issues.length ? <CodeEmpty icon={<CircleDot size={16} />} title="No GitHub issues" />
      : <ul className="code-list">{github.snapshot.issues.map(issue => <li key={issue.number} className="code-row">
        <span className={`repository-state ${issue.state}`} aria-label={issue.state}>{issue.state === "open" ? <CircleDot size={14} /> : <CircleCheck size={14} />}</span>
        <div className="code-row-main">
          <a className="code-row-title" href={issue.url} target="_blank" rel="noreferrer">{issue.title}</a>
          <span className="repository-meta"><span>#{issue.number}</span>{issue.author && <span>{issue.author}</span>}</span>
        </div>
        <time className="code-row-time" dateTime={new Date(issue.updatedAt).toISOString()}>{formatRelative(issue.updatedAt)}</time>
      </li>)}</ul>)}
    {settings}
  </section>;
}

function CodeEmpty({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return <div className="code-empty"><span aria-hidden="true">{icon}</span><strong>{title}</strong>{hint && <p>{hint}</p>}</div>;
}
