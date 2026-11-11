// Two-way GitHub issue sync: the pure parts shared by Convex (convex/githubIssueSync.ts) and the Next worker
// (lib/github-sync.ts). Origin keeps, per issue, a fingerprint of the title, body and labels both sides last agreed on
// (`githubIssueMirrors`); a side whose content differs from that fingerprint changed since, so an echo of our own
// write (identical content) never counts as a change and never bounces back.

export const MAX_TITLE = 250;
export const MAX_BODY = 60000;
const MAX_LABELS = 20;
const MAX_LABEL_LENGTH = 32;

export const taskMarker = (taskId: string) => `<!-- origin-task:${taskId} -->`;
const MARKER = /\n*<!-- origin-task:[^>]{1,64} -->\s*/g;

/** The body Origin writes: the issue description, then the hidden marker that ties the GitHub issue to the task. */
export function githubBody(taskId: string, description?: string) {
  return `${(description ?? "").trim()}\n\n${taskMarker(taskId)}`.trim();
}

/** A GitHub body as an Origin description: without our marker, line endings normalized, within Origin's limit. */
export function originDescription(body?: string | null) {
  return (body ?? "").replace(MARKER, "\n").replace(/\r\n?/g, "\n").trim().slice(0, MAX_BODY);
}

export function originTitle(title: string) {
  return title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

/** GitHub label objects (or names) as Origin label names: trimmed, de-duplicated, within Origin's limits. */
export function originLabels(labels: readonly (string | { name?: string | null })[] | undefined) {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const label of labels ?? []) {
    const name = (typeof label === "string" ? label : label.name ?? "").trim().replace(/\s+/g, " ");
    if (!name || name.length > MAX_LABEL_LENGTH || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names.slice(0, MAX_LABELS);
}

/** cyrb53: a small stable string hash; enough to tell "same content" from "changed" without storing the content. */
function cyrb53(value: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const titleHash = (title: string) => cyrb53(`t:${originTitle(title)}`);
export const bodyHash = (description?: string | null) => cyrb53(`b:${originDescription(description)}`);
export const labelsHash = (labels: readonly string[] | undefined) => cyrb53(`l:${originLabels(labels).map(label => label.toLowerCase()).sort().join("\n")}`);

/** The content of one GitHub issue as the worker reports it to Convex; a missing field is left alone. */
export type RemoteIssue = { number: number; state: "open" | "closed"; updatedAt: number; title?: string; body?: string; labels?: string[] };

/** A GitHub REST issue as a RemoteIssue. */
export function remoteIssue(issue: { number: number; state: "open" | "closed"; updated_at: string; title?: string; body?: string | null; labels?: (string | { name?: string | null })[] }): RemoteIssue {
  return {
    number: issue.number, state: issue.state, updatedAt: Date.parse(issue.updated_at),
    ...(typeof issue.title === "string" ? { title: issue.title } : {}),
    ...(issue.body !== undefined ? { body: issue.body ?? "" } : {}),
    ...(Array.isArray(issue.labels) ? { labels: originLabels(issue.labels) } : {}),
  };
}

/** The issue fields to PATCH on GitHub; empty when GitHub already matches Origin. */
export type IssuePatch = { title?: string; body?: string; labels?: string[]; state?: "open" | "closed"; state_reason?: "completed" | "not_planned" | "reopened" };
