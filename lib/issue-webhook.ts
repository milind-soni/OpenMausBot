/**
 * Outgoing issue webhooks: the payload Origin POSTs when an issue is created or its status changes, and its
 * signature. Shared by Convex (convex/issueWebhooks.ts), scripts/origin-webhook-test.mjs and the tests, so it imports
 * nothing and uses only WebCrypto.
 *
 * Headers: `X-Origin-Event` (issue.created | issue.updated), `X-Origin-Delivery` (the event id) and
 * `X-Origin-Signature: sha256=<hex>`, the HMAC-SHA256 of the raw body under the webhook secret (like GitHub's).
 */

export type IssueWebhookEvent = "issue.created" | "issue.updated";
export type IssueWebhookCriterion = { text: string; checked: boolean };
export type IssueWebhookChanges = { status?: { from: string; to: string }; completed?: { from: boolean; to: boolean } };
export type IssueWebhookPayload = {
  id: string;
  type: IssueWebhookEvent;
  occurredAt: string;
  workspace: { id: string; name: string; slug: string };
  project: { id: string; name: string; repo: string | null };
  issue: {
    id: string; key: string; title: string; description: string; labels: string[]; url: string; status: string; completed: boolean;
    assignee: { email: string; name: string } | null; acceptanceCriteria: IssueWebhookCriterion[];
  };
  changes: IssueWebhookChanges | null;
};
export type IssueWebhookInput = {
  id?: string;
  type: IssueWebhookEvent;
  occurredAt: number;
  workspace: { id: string; name: string; slug: string };
  project: { id: string; name: string; repoUrl?: string };
  issue: {
    id: string; key: string; title: string; description?: string; labels?: readonly string[]; status: string; completed: boolean;
    assignee?: { email: string; name?: string } | null; acceptanceCriteria?: readonly IssueWebhookCriterion[];
  };
  changes?: IssueWebhookChanges | null;
  /** ORIGIN_PUBLIC_URL; without it `issue.url` stays a path. */
  origin?: string;
};

/** Webhook secrets are at least this long, like ORIGIN_INTEGRATION_SECRET. */
export const ISSUE_WEBHOOK_MIN_SECRET = 32;
export const ISSUE_WEBHOOK_TIMEOUT_MS = 10_000;

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

export function issueWebhookEventId() {
  return `evt_${hex(crypto.getRandomValues(new Uint8Array(12)))}`;
}

/** `owner/repo` for a GitHub repository URL (or `owner/repo` itself), otherwise null. */
export function repositorySlug(repoUrl?: string) {
  const value = repoUrl?.trim();
  if (!value) return null;
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(value) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(value);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** What changed between two snapshots of an issue's status, or null when neither the status nor completion did. */
export function issueWebhookChanges(before: { status: string; completed: boolean }, after: { status: string; completed: boolean }): IssueWebhookChanges | null {
  const changes: IssueWebhookChanges = {};
  if (before.status !== after.status) changes.status = { from: before.status, to: after.status };
  if (before.completed !== after.completed) changes.completed = { from: before.completed, to: after.completed };
  return changes.status || changes.completed ? changes : null;
}

/** The payload with its keys in the documented order, so `JSON.stringify` of it is the exact body. */
export function issueWebhookPayload(input: IssueWebhookInput): IssueWebhookPayload {
  const origin = input.origin?.trim().replace(/\/+$/, "") ?? "";
  return {
    id: input.id ?? issueWebhookEventId(),
    type: input.type,
    occurredAt: new Date(input.occurredAt).toISOString(),
    workspace: { id: input.workspace.id, name: input.workspace.name, slug: input.workspace.slug },
    project: { id: input.project.id, name: input.project.name, repo: repositorySlug(input.project.repoUrl) },
    issue: {
      id: input.issue.id,
      key: input.issue.key,
      title: input.issue.title,
      description: input.issue.description ?? "",
      labels: [...input.issue.labels ?? []],
      url: `${origin}/${input.workspace.slug}/issue/${input.issue.key}`,
      status: input.issue.status,
      completed: input.issue.completed,
      assignee: input.issue.assignee?.email ? { email: input.issue.assignee.email, name: input.issue.assignee.name || input.issue.assignee.email } : null,
      acceptanceCriteria: (input.issue.acceptanceCriteria ?? []).map(item => ({ text: item.text, checked: item.checked })),
    },
    changes: input.type === "issue.created" ? null : input.changes ?? null,
  };
}

/** `sha256=<hex>`: HMAC-SHA256 of the raw body under the secret. */
export async function signIssueWebhook(body: string, secret: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `sha256=${hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body))))}`;
}

/** The exact body and headers of one delivery. */
export async function issueWebhookRequest(payload: IssueWebhookPayload, secret: string) {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Origin-Event": payload.type,
      "X-Origin-Delivery": payload.id,
      "X-Origin-Signature": await signIssueWebhook(body, secret),
    },
  };
}

/** POSTs a signed body; resolves to the HTTP status. Rejects on a network error or after the timeout. */
export async function postIssueWebhook(url: string, request: { body: string; headers: Record<string, string> }, timeoutMs = ISSUE_WEBHOOK_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "POST", headers: request.headers, body: request.body, signal: controller.signal });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } finally { clearTimeout(timer); }
}

/** An http(s) URL without credentials, or an error message. */
export function issueWebhookUrlError(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return "Enter the webhook URL, starting with https://"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http or https URL";
  if (url.username || url.password) return "Leave credentials out of the URL; the signature authenticates Origin";
  return null;
}

/** A sample event for scripts/origin-webhook-test.mjs. */
export function sampleIssueWebhookPayload(type: IssueWebhookEvent = "issue.created", origin?: string) {
  return issueWebhookPayload({
    type,
    occurredAt: Date.now(),
    workspace: { id: "sample_workspace", name: "Sample", slug: "sample" },
    project: { id: "sample_project", name: "Origin", repoUrl: "https://github.com/z4mbo/Origin" },
    issue: {
      id: "sample_issue", key: "ORI-AB12", title: "Rough note: import issues from a CSV", description: "", labels: ["Needs spec"],
      status: type === "issue.created" ? "Draft" : "Todo", completed: false, assignee: null, acceptanceCriteria: [],
    },
    changes: type === "issue.updated" ? { status: { from: "Draft", to: "Todo" } } : null,
    origin,
  });
}
