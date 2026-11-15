import { z } from "zod";
import type { WebhookEvent } from "./webhooks.ts";

const repository = z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/).max(200).transform((value) => value.toLowerCase());
const revision = z.string().regex(/^[a-fA-F0-9]{40}$/).transform((value) => value.toLowerCase());
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const githubCompletionSchema = z.object({
  kind: z.literal("github_completion"), webhookId: z.string().min(1).max(200), repository, revision,
  subject: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("workflow_run"), id, attempt: id }).strict(),
    z.object({ kind: z.literal("pull_request_review"), id }).strict(),
  ]),
}).strict();
export type GitHubCompletion = z.infer<typeof githubCompletionSchema>;
export const githubScopeSchema = z.object({ webhookId: z.string().min(1).max(200), repository }).strict();
export type GitHubScope = z.infer<typeof githubScopeSchema>;

export function registeredGitHubOwnerRun(run: { eventSource?: string; ownerGitHub?: unknown; resultsThreadId?: string; threadId?: string } | null): boolean {
  return Boolean(run?.eventSource === "wait" && run.threadId && run.resultsThreadId === run.threadId && githubScopeSchema.safeParse(run.ownerGitHub).success);
}

export function registeredGitHubOwnerScope(run: { botId: string; eventSource?: string; ownerGitHub?: GitHubScope; resultsThreadId?: string; threadId?: string } | null, botId: string, threadId: string, eligible: boolean): GitHubScope | null {
  return eligible && registeredGitHubOwnerRun(run) && run?.botId === botId && run.resultsThreadId === threadId ? run.ownerGitHub ?? null : null;
}

const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workflow_run"), id, attempt: id }).strict(),
  z.object({ kind: z.literal("pull_request_review"), id }).strict(),
]);
export const githubWaitInputSchema = z.object({
  webhook_id: z.string().min(1).max(200), repository, revision,
  run_id: id.optional(), run_attempt: id.optional(), pull_request: id.optional(),
}).strict().transform((input, ctx) => {
  const subject = input.pull_request !== undefined && input.run_id === undefined && input.run_attempt === undefined
    ? { kind: "pull_request_review", id: input.pull_request }
    : input.pull_request === undefined ? { kind: "workflow_run", id: input.run_id, attempt: input.run_attempt } : null;
  const parsed = target.safeParse(subject);
  if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Use run_id and run_attempt, or pull_request, with an exact revision." }); return z.NEVER; }
  return { kind: "github_completion" as const, webhookId: input.webhook_id, repository: input.repository, revision: input.revision, subject: parsed.data };
});

const workflow = z.object({ action: z.literal("completed"), repository: z.object({ full_name: repository }), workflow_run: z.object({ id, run_attempt: id, head_sha: revision, status: z.literal("completed") }) });
const review = z.object({ action: z.literal("submitted"), repository: z.object({ full_name: repository }), pull_request: z.object({ number: id }), review: z.object({ commit_id: revision }) });

// A matching authenticated event wakes only a previously registered owner. No payload text, destination or claimed approval becomes an instruction.
export function matchesGitHubCompletion(condition: GitHubCompletion, webhookId: string, event: WebhookEvent): boolean {
  const completion = gitHubCompletionFromEvent(webhookId, event);
  return completion !== null && sameGitHubCompletion(condition, completion);
}

export function sameGitHubCompletion(a: GitHubCompletion, b: GitHubCompletion): boolean {
  return a.webhookId === b.webhookId && a.repository === b.repository && a.revision === b.revision
    && a.subject.kind === b.subject.kind && a.subject.id === b.subject.id
    && (a.subject.kind !== "workflow_run" || b.subject.kind === "workflow_run" && a.subject.attempt === b.subject.attempt);
}

export function gitHubCompletionFromEvent(webhookId: string, event: WebhookEvent): GitHubCompletion | null {
  if (event.eventName === "workflow_run") {
    const parsed = workflow.safeParse(event.payload);
    return parsed.success ? { kind: "github_completion", webhookId, repository: parsed.data.repository.full_name, revision: parsed.data.workflow_run.head_sha,
      subject: { kind: "workflow_run", id: parsed.data.workflow_run.id, attempt: parsed.data.workflow_run.run_attempt } } : null;
  }
  if (event.eventName === "pull_request_review") {
    const parsed = review.safeParse(event.payload);
    return parsed.success ? { kind: "github_completion", webhookId, repository: parsed.data.repository.full_name, revision: parsed.data.review.commit_id,
      subject: { kind: "pull_request_review", id: parsed.data.pull_request.number } } : null;
  }
  return null;
}
