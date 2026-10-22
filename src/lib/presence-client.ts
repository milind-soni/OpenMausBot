export const PRESENCE_MIN_INTERVAL_MS = 60_000;

export function presenceBody(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): { source: "desktop"; timeZone?: string } {
  return timeZone ? { source: "desktop", timeZone } : { source: "desktop" };
}

export function duePing(lastAt: number | null, now: number): boolean {
  return lastAt === null || now - lastAt >= PRESENCE_MIN_INTERVAL_MS;
}


export function openTarget(answer: unknown): { botId: string; threadId: string } | null {
  if (!answer || typeof answer !== "object") return null;
  const open = (answer as { open?: unknown }).open;
  if (!open || typeof open !== "object") return null;
  const { botId, threadId } = open as { botId?: unknown; threadId?: unknown };
  return typeof botId === "string" && typeof threadId === "string" && botId && threadId ? { botId, threadId } : null;
}
