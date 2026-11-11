"use client";
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { localApi } from "@/lib/client-api";

type PullRequest = Pick<Doc<"taskPullRequests">, "_id" | "url" | "number" | "state" | "checks" | "review" | "mergeable" | "title" | "closes">;

const PR_ICON = { draft: GitPullRequestDraft, open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;
const CHECKS: Record<string, string> = { success: "checks pass", failure: "checks fail", pending: "checks running" };
const REVIEW: Record<string, string> = { approved: "approved", changes_requested: "changes requested", review_required: "review required" };

/**
 * Pull requests linked to an issue, one line each: state, title, then only the facts that need attention. Each opens
 * the PR on GitHub, where it is reviewed and merged; merging completes the issue unless the link only references it.
 */
export function TaskPullRequests({ prs }: { prs: PullRequest[] }) {
  return <>{prs.map(pr => {
    const Icon = PR_ICON[pr.state];
    const active = pr.state === "open" || pr.state === "draft";
    const facts = [
      pr.state === "draft" ? "draft" : pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : "",
      active ? CHECKS[pr.checks] ?? "" : "",
      active ? REVIEW[pr.review] ?? "" : "",
      active && pr.mergeable === false ? "conflicts" : "",
      active && pr.closes === false ? "won't complete on merge" : "",
    ].filter(Boolean);
    return <a key={pr._id} className="issue-github-link" data-state={pr.state} href={pr.url} target="_blank" rel="noreferrer">
      <Icon size={14} /><span>#{pr.number}</span><small>{[pr.title, ...facts].filter(Boolean).join(" · ")}</small>
    </a>;
  })}</>;
}

/** Asks the server to open a (draft) pull request for the issue; resolves to the server's message. */
export async function createTaskPullRequest(projectId: Id<"projects">, taskId: Id<"tasks">, sessionToken: string) {
  const result = await localApi<{ message: string }>("/api/github/pull-requests", sessionToken, { method: "POST", json: { projectId, taskId } });
  return result.message;
}
