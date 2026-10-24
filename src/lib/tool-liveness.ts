export interface LiveToolRun { busy?: boolean; turnStartedAt?: number | null }
export interface ToolRunMessage {
  id: string; at: number; turnId?: string; turnTerminal?: boolean; turnCompletedAt?: number;
  role: "bot" | "user"; kind: string;
}

export function liveToolIds(messages: readonly ToolRunMessage[], run?: LiveToolRun): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!run?.busy || !Number.isFinite(run.turnStartedAt) || run.turnStartedAt == null) return ids;
  const completedTurns = new Set(messages.filter(message => message.turnId && (message.turnTerminal || message.turnCompletedAt != null)).map(message => message.turnId));
  for (const message of messages) {
    if (message.kind === "activity" && message.at >= run.turnStartedAt &&
      !message.turnTerminal && message.turnCompletedAt == null &&
      (!message.turnId || !completedTurns.has(message.turnId))) ids.add(message.id);
  }
  return ids;
}
