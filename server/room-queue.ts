import type { RoomQueueEntry } from "../shared/wire.ts";

export interface RoomLineItem {
  botId: string;
  threadId: string;
  state: "running" | "queued";
  assignmentId?: string;
}

export function roomQueue(items: readonly RoomLineItem[], speakers: ReadonlyMap<string, string> = new Map()): RoomQueueEntry[] {
  const lines = new Map<string, RoomLineItem[]>();
  for (const item of items) {
    const line = lines.get(item.threadId) ?? [];
    const index = line.findIndex(other => other.botId === item.botId);
    const placed = line[index];
    if (!placed) line.push(item);
    else line[index] = { ...placed, ...(item.state === "running" ? { state: "running" as const } : {}),
      ...(!placed.assignmentId && item.assignmentId ? { assignmentId: item.assignmentId } : {}) };
    lines.set(item.threadId, line);
  }
  const entries: RoomQueueEntry[] = [];
  for (const [threadId, raw] of lines) {
    const line = [...raw.filter(item => item.state === "running"), ...raw.filter(item => item.state === "queued")];
    if (!line.some(item => item.state === "queued")) continue;
    const running = line.find(item => item.state === "running");
    const speaker = speakers.get(threadId);
    line.forEach((item, index) => {
      const ahead = index > 0 ? line[index - 1]!.botId : undefined;
      const waitingFor = item.state === "running" ? undefined
        : running?.botId ?? ahead ?? (speaker !== item.botId ? speaker : undefined);
      entries.push({
        botId: item.botId, threadId, state: item.state, position: index + 1, of: line.length,
        ...(waitingFor ? { waitingForBotId: waitingFor } : {}),
        ...(item.assignmentId ? { assignmentId: item.assignmentId } : {}),
      });
    });
  }
  return entries;
}

export function queuedJobDetail(entry: RoomQueueEntry, nameOf: (botId: string) => string): string {
  const after = entry.waitingForBotId ? `, after ${nameOf(entry.waitingForBotId)}` : "";
  return `queued ${entry.position} of ${entry.of} in this room: room jobs run one at a time, so it starts in turn${after}`;
}

export function sequentialRoomNotice(line: readonly RoomQueueEntry[], sent: ReadonlySet<string>, nameOf: (botId: string) => string): string | undefined {
  const waiting = line.filter(entry => entry.state === "queued" && entry.assignmentId !== undefined && sent.has(entry.assignmentId));
  if (!waiting.length || line.length < 2) return undefined;
  const order = line.map(entry => `${nameOf(entry.botId)} (${entry.position} of ${entry.of}${entry.state === "running" ? ", running" : ""})`).join(", ");
  return `These run one at a time in this room, not in parallel: ${order}. Tell the person they are queued and run in turn; do not say they are all under way or dispatched in parallel.`;
}
