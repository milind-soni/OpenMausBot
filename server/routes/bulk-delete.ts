export const MAX_BULK_DELETE_THREADS = 500;

export type BulkDeleteRefusal = { threadId: string; reason: "not-found" | "busy" };

/** The distinct thread ids of a bulk delete body, or the 400 error to answer with. */
export function bulkDeleteThreadIds(body: unknown): { ok: true; threadIds: string[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const ids = (body as { threadIds?: unknown }).threadIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK_DELETE_THREADS
    || ids.some((id) => typeof id !== "string" || id === "")) {
    return { ok: false, error: `threadIds must be 1-${MAX_BULK_DELETE_THREADS} thread ids` };
  }
  return { ok: true, threadIds: [...new Set(ids as string[])] };
}
