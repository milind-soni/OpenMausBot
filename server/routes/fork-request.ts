export function forkMessageId(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
    Object.keys(body).some((key) => key !== "messageId") ||
    typeof (body as { messageId?: unknown }).messageId !== "string") return null;
  return (body as { messageId: string }).messageId;
}
