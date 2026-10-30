export interface LiveToolRun { busy?: boolean; turnStartedAt?: number | null }
export interface ToolRunMessage {
  id: string; at: number; turnId?: string; turnTerminal?: boolean; turnCompletedAt?: number;
  role: "bot" | "user"; kind: string;
}

const EMPTY_LIVE_TOOLS: ReadonlySet<string> = new Set();

export function liveToolIds(messages: readonly ToolRunMessage[], run?: LiveToolRun): ReadonlySet<string> {
  if (!run?.busy || !Number.isFinite(run.turnStartedAt) || run.turnStartedAt == null) return EMPTY_LIVE_TOOLS;
  const completedTurns = new Set(messages.filter((message) => message.turnId && (message.turnTerminal || message.turnCompletedAt != null)).map((message) => message.turnId));
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.kind === "activity" && message.at >= run.turnStartedAt &&
      !message.turnTerminal && message.turnCompletedAt == null &&
      (!message.turnId || !completedTurns.has(message.turnId))) ids.add(message.id);
  }
  return ids.size === 0 ? EMPTY_LIVE_TOOLS : ids;
}
