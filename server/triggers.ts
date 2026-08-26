// Listener triggers: waking a bot because something happened in an app,
// rather than because a clock struck.
//
// A routine today fires `once` or `daily`, or on any authenticated delivery to
// its webhook. That last one is the raw material — the endpoint, the shared
// secret, the replay guard and the delivery receipts all already exist in
// webhooks.ts. What was missing is the ability to say WHICH deliveries matter:
// "a PR opened on this repo, by one of these people" rather than "anything
// GitHub sends me".
//
// Two rules shape everything here:
//
//   1. A listener event is third-party text. It reaches a prompt only inside
//      an explicit untrusted boundary, and the boundary marker is stripped
//      out of the payload so a hostile title cannot close it early.
//   2. Being too loose is worse than being too tight. An unrecognised event
//      normalizes to null and matches nothing, rather than falling through to
//      some catch-all that wakes a bot at 3am.

import { z } from "zod";

import type { JsonValue } from "./schema.ts";

export type GithubEventKind =
  | "pr-opened"
  | "pr-pushed"
  | "pr-merged"
  | "pr-closed"
  | "pr-comment"
  | "review-approved"
  | "review-changes-requested"
  | "issue-opened"
  | "issue-comment"
  | "push"
  | "ci-passed"
  | "ci-failed";

export type SlackMatch =
  | { kind: "message" }
  | { kind: "mention" }
  | { kind: "keyword"; keyword: string };

export type EventListener =
  | {
      type: "github";
      repo: string;
      events: string[];
      /** Only fire for these logins. Empty/absent means anyone. */
      userAllowlist?: string[];
      /** CI listeners only: hold to one branch. */
      ciBranch?: string;
    }
  | { type: "slack"; channel: string; match: SlackMatch };

export interface NormalizedEvent {
  source: "github" | "slack";
  kind: string;
  repo?: string;
  actor?: string;
  title?: string;
  branch?: string;
  channel?: string;
  text?: string;
}

const login = z.object({ login: z.string().optional() });
const runSchema = z.object({
  conclusion: z.string().optional(),
  head_branch: z.string().optional(),
  name: z.string().optional(),
});

const githubPayloadSchema = z.object({
  action: z.string().optional(),
  ref: z.string().optional(),
  repository: z.object({ full_name: z.string().optional() }).optional(),
  sender: login.optional(),
  pull_request: z
    .object({ title: z.string().optional(), merged: z.boolean().optional(), user: login.optional() })
    .optional(),
  issue: z
    .object({ title: z.string().optional(), user: login.optional(), pull_request: z.unknown().optional() })
    .optional(),
  review: z.object({ state: z.string().optional() }).optional(),
  workflow_run: runSchema.optional(),
  check_suite: runSchema.optional(),
});
type GithubPayload = z.infer<typeof githubPayloadSchema>;

const slackPayloadSchema = z.object({
  type: z.string().optional(),
  event: z
    .object({
      type: z.string().optional(),
      channel: z.string().optional(),
      text: z.string().optional(),
      user: z.string().optional(),
      bot_id: z.string().optional(),
      subtype: z.string().optional(),
    })
    .optional(),
});

/** Trim to a value worth carrying, or drop it. Every field on a normalized
 * event is optional precisely so an empty one is absent rather than "". */
function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** GitHub's (event, action) pair collapsed to one name a person would
 * recognise in a picker. An unlisted pair yields undefined, which becomes a
 * null event — an unsubscribable kind must never wake anything. */
function githubKind(event: string, payload: GithubPayload): GithubEventKind | undefined {
  const action = payload.action;
  if (event === "push") return "push";
  if (event === "pull_request") {
    if (action === "opened" || action === "reopened") return "pr-opened";
    if (action === "synchronize") return "pr-pushed";
    if (action === "closed") return payload.pull_request?.merged === true ? "pr-merged" : "pr-closed";
    return undefined;
  }
  if (event === "pull_request_review" && action === "submitted") {
    const state = payload.review?.state?.toLowerCase();
    if (state === "approved") return "review-approved";
    if (state === "changes_requested") return "review-changes-requested";
    return undefined;
  }
  if (event === "issue_comment" && action === "created") {
    return payload.issue?.pull_request === undefined ? "issue-comment" : "pr-comment";
  }
  if (event === "issues" && action === "opened") return "issue-opened";
  if ((event === "workflow_run" || event === "check_suite") && action === "completed") {
    const conclusion = (payload.workflow_run ?? payload.check_suite)?.conclusion?.toLowerCase();
    if (conclusion === "success") return "ci-passed";
    if (conclusion === "failure" || conclusion === "timed_out") return "ci-failed";
    return undefined;
  }
  return undefined;
}

function normalizeGithub(event: string, payload: GithubPayload): NormalizedEvent | null {
  const kind = githubKind(event, payload);
  if (!kind) return null;
  const run = payload.workflow_run ?? payload.check_suite;
  const normalized: NormalizedEvent = { source: "github", kind };
  // repos compare lowercase throughout: GitHub treats owner/name
  // case-insensitively and a listener typed by hand will not match its casing
  const repo = trimmed(payload.repository?.full_name)?.toLowerCase();
  if (repo) normalized.repo = repo;
  const actor = trimmed(payload.pull_request?.user?.login ?? payload.sender?.login ?? payload.issue?.user?.login);
  if (actor) normalized.actor = actor;
  const title = trimmed(payload.pull_request?.title ?? payload.issue?.title ?? run?.name);
  if (title) normalized.title = title;
  const branch = trimmed(run?.head_branch ?? payload.ref?.replace(/^refs\/heads\//, ""));
  if (branch) normalized.branch = branch;
  return normalized;
}

function normalizeSlack(payload: z.infer<typeof slackPayloadSchema>): NormalizedEvent | null {
  const inner = payload.event;
  if (!inner) return null;
  // a bot's own message must never trigger a listener: that is how one
  // careless routine turns into a loop nobody can stop from the outside
  if (inner.bot_id !== undefined || inner.subtype === "bot_message") return null;
  const kind = inner.type === "app_mention" ? "mention" : inner.type === "message" ? "message" : undefined;
  const channel = trimmed(inner.channel);
  if (!kind || !channel) return null;
  const normalized: NormalizedEvent = { source: "slack", kind, channel };
  const text = trimmed(inner.text);
  if (text) normalized.text = text;
  const actor = trimmed(inner.user);
  if (actor) normalized.actor = actor;
  return normalized;
}

export function normalizeWebhookEvent(
  headers: Record<string, string | undefined>,
  payload: JsonValue,
): NormalizedEvent | null {
  // Slack is checked first because it is identifiable from the BODY alone.
  // The header a caller passes here is whatever the ingress read out of
  // x-github-event / x-webhook-event / x-event-type, so a Slack delivery that
  // happens to carry one of those must not be dragged down the GitHub path.
  const slack = slackPayloadSchema.safeParse(payload);
  if (slack.success && slack.data.type === "event_callback") return normalizeSlack(slack.data);
  const githubEvent = trimmed(headers["x-github-event"]);
  if (githubEvent) {
    const parsed = githubPayloadSchema.safeParse(payload);
    return parsed.success ? normalizeGithub(githubEvent, parsed.data) : null;
  }
  return null;
}

const sameLogin = (a: string, b: string) =>
  a.replace(/^@+/, "").toLowerCase() === b.replace(/^@+/, "").toLowerCase();

export function listenerMatches(listener: EventListener, event: NormalizedEvent): boolean {
  if (listener.type !== event.source) return false;
  if (listener.type === "github") {
    if (!event.repo || listener.repo.toLowerCase() !== event.repo.toLowerCase()) return false;
    if (!listener.events.includes(event.kind)) return false;
    if (listener.ciBranch !== undefined && event.branch !== listener.ciBranch) return false;
    const allow = listener.userAllowlist ?? [];
    if (allow.length > 0 && !(event.actor && allow.some((login) => sameLogin(login, event.actor!)))) return false;
    return true;
  }
  if (listener.channel !== event.channel) return false;
  if (listener.match.kind === "mention") return event.kind === "mention";
  if (listener.match.kind === "message") return true;
  return (event.text ?? "").toLowerCase().includes(listener.match.keyword.toLowerCase());
}

const OPEN = "[UNTRUSTED LISTENER EVENT DATA]";
const CLOSE = "[/UNTRUSTED LISTENER EVENT DATA]";

/** One line a person would recognise in a chip or a notification. */
export function describeEvent(event: NormalizedEvent): string {
  if (event.source === "github") {
    const what = event.title ? `: "${event.title}"` : "";
    const who = event.actor ? ` by ${event.actor}` : "";
    return `${event.kind} in ${event.repo ?? "a repo"}${what}${who}`;
  }
  return `${event.kind} in ${event.channel ?? "a channel"}${event.text ? `: "${event.text}"` : ""}`;
}

/** The event as prompt material — inside a boundary, with the boundary's own
 * markers stripped out of the content so a hostile title cannot close it and
 * continue as instruction. */
const CONTEXT_FIELDS = ["source", "kind", "repo", "actor", "title", "branch", "channel", "text"] as const;

export function buildEventContextBlock(event: NormalizedEvent): string {
  const scrub = (value: string) => value.split(OPEN).join("").split(CLOSE).join("").slice(0, 2_000);
  const lines: string[] = [];
  for (const field of CONTEXT_FIELDS) {
    const value = event[field];
    if (value !== undefined && value !== "") lines.push(`${field}: ${scrub(value)}`);
  }
  return [OPEN, ...lines, CLOSE].join("\n");
}
