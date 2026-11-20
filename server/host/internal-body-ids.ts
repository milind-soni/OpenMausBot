/** The bearer is the authority: a body that names another bot or conversation than the capability's own is refused, so
 * a turn's bearer (live, or an ended turn's for its late tool output) writes only into its own bot and thread. */
export function internalBodyRefusal(body: unknown, botId: string, threadId: string): { status: 403; error: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  for (const key of ["fromBotId", "botId"]) {
    if (fields[key] !== undefined && String(fields[key]) !== botId) return { status: 403, error: "the internal capability belongs to a different bot" };
  }
  for (const key of ["fromThreadId", "threadId"]) {
    if (fields[key] !== undefined && String(fields[key]) !== threadId) return { status: 403, error: "the internal capability belongs to a different conversation" };
  }
  return null;
}
