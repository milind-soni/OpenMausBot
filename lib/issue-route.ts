import { taskKey } from "./project-issues";

/**
 * Issue pages live at `/{workspace}/issue/{KEY}/{taskId}`. The key (`ORI-1A2B`) is what people read; it is only the
 * last four characters of the id, so two issues can share one. The id segment keeps a link exact, the way Linear's
 * trailing title slug follows its key. `/{workspace}/issue/{KEY}` alone still works and is resolved by the key.
 */
export type IssueRoute = { slug: string | null; key: string; taskId?: string };

const KEY = /^ori-([a-z0-9]{4})$/i;
const ID = /^[a-z0-9]{16,64}$/;

export function issuePath(slug: string, taskId: string) {
  return `/${slug}/issue/${taskKey(taskId)}/${taskId}`;
}

/** The four id characters a key stands for, or null when `value` is not an issue key. */
export function keySuffix(value: string) {
  return KEY.exec(value.trim())?.[1]?.toLowerCase() ?? null;
}

/** Reads an issue page path; `slug` is null for the workspace-less `/issue/{KEY}` form. */
export function parseIssuePath(pathname: string): IssueRoute | null {
  const parts = pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
  const at = parts[0] === "issue" ? 0 : parts[1] === "issue" ? 1 : -1;
  if (at < 0 || parts.length > at + 3) return null;
  const key = parts[at + 1];
  if (!key) return null;
  const id = parts[at + 2];
  // A bare id is accepted in place of the key too: /acme/issue/<taskId>.
  if (!keySuffix(key) && !ID.test(key)) return null;
  if (id !== undefined && !ID.test(id)) return null;
  return { slug: at === 1 ? parts[0]! : null, key: keySuffix(key) ? key.toUpperCase() : taskKey(key), taskId: id ?? (keySuffix(key) ? undefined : key) };
}

/** Issues whose key is `key`, for resolving a link without an id. More than one means the link is ambiguous. */
export function issuesForKey<T extends { _id: string }>(tasks: readonly T[], key: string) {
  const suffix = keySuffix(key);
  return suffix ? tasks.filter(task => task._id.slice(-4).toLowerCase() === suffix) : [];
}

/** `?project=…&issue=…` links from before issue pages existed, redirected to the page. */
export function legacyIssueParams(search: string) {
  const params = new URLSearchParams(search);
  const projectId = params.get("project"), taskId = params.get("issue");
  return projectId && taskId && ID.test(taskId) ? { projectId, taskId } : null;
}
