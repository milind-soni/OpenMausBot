import { api, type AppState } from "@/state/store";

/** Only the desktop app on this computer sends reports: a browser, a phone or a page from another server has no way to. */
export function canSendBugReports(): boolean {
  return typeof window !== "undefined" && typeof window.ogb?.sendBugReport === "function";
}

/** The conversation on screen, which a report may include. */
export function openChatThreadId(state: Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">): string | undefined {
  if (state.activeView !== "chat") return undefined;
  const group = state.groups.find((candidate) => candidate.id === state.selectedId);
  if (group) return group.threadId;
  return (state.bots.find((candidate) => candidate.id === state.selectedId) ?? state.bots[0])?.threadId;
}

export async function settleBugReportCard(
  ref: { botId: string; threadId: string; messageId: string },
  outcome: "sent" | "dismissed",
  reportId?: string,
): Promise<void> {
  await api(`/api/bots/${encodeURIComponent(ref.botId)}/bug-report-cards/${encodeURIComponent(ref.messageId)}/${outcome}`, {
    method: "POST",
    body: JSON.stringify({ threadId: ref.threadId, ...(reportId ? { reportId } : {}) }),
  });
}

export const errorText = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
