import { CircleDot, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";

export type PullRequestState = "draft" | "open" | "closed" | "merged";
export type LinkedPullRequest = { number: number; state: PullRequestState };

const PR_ICON = { draft: GitPullRequestDraft, open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;
const PR_LABEL = { draft: "draft", open: "open", merged: "merged", closed: "closed" } as const;

/** The issue's link to GitHub next to its key: its pull request (coloured by state) or else its GitHub issue. */
export function GitHubIssueIndicator({ number, pullRequest }: { number?: number; pullRequest?: LinkedPullRequest }) {
  if (pullRequest) {
    const Icon = PR_ICON[pullRequest.state];
    const label = `Pull request #${pullRequest.number}, ${PR_LABEL[pullRequest.state]}`;
    return <span className="github-issue-indicator" data-state={pullRequest.state} role="img" title={label} aria-label={label}><Icon size={13} aria-hidden="true" /></span>;
  }
  if (!number) return null;
  return <span className="github-issue-indicator" role="img" title={`GitHub issue #${number}`} aria-label={`GitHub issue #${number}`}><CircleDot size={13} aria-hidden="true" /></span>;
}
