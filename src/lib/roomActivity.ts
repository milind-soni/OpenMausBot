export type RoomActivityStatus = "waiting" | "running" | "approval" | "completed" | "cancelled" | "failed";
export type RoomActivityEntryStatus = "running" | "waiting" | "completed" | "cancelled" | "failed";

export interface RoomActivityEntry {
  id: string;
  kind: "tool" | "approval" | "error";
  title: string;
  status: RoomActivityEntryStatus;
  startedAt: number;
  updatedAt: number;
}

export interface RoomAgentActivity {
  status: RoomActivityStatus;
  turnId?: string;
  startedAt?: number;
  updatedAt: number;
  entries: RoomActivityEntry[];
}

export type RoomActivityState = Record<string, Record<string, RoomAgentActivity>>;

export function clearRoomActivity(state: RoomActivityState, threadId: string): RoomActivityState {
  if (!(threadId in state)) return state;
  const { [threadId]: _cleared, ...remaining } = state;
  return remaining;
}

interface RuntimeEventLike {
  eventId?: string;
  type: string;
  threadId: string;
  createdAt?: string;
  turnId?: string;
  itemId?: string;
  requestId?: string;
  source?: string;
  itemType?: string;
  title?: string;
  tool?: string;
  summary?: string;
  message?: string;
  ok?: boolean;
  stopReason?: string | null;
}

const HISTORY_LIMIT = 12;

function eventTime(event: RuntimeEventLike): number {
  const parsed = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function upsertEntry(entries: RoomActivityEntry[], entry: RoomActivityEntry): RoomActivityEntry[] {
  const existing = entries.findIndex((item) => item.id === entry.id);
  const next = existing < 0 ? [entry, ...entries] : entries.map((item, index) => index === existing ? entry : item);
  return next
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, HISTORY_LIMIT);
}

function settleOpenEntries(entries: RoomActivityEntry[], status: "completed" | "cancelled" | "failed", at: number): RoomActivityEntry[] {
  return entries.map((entry) =>
    entry.status === "running" || entry.status === "waiting"
      ? { ...entry, status, updatedAt: at }
      : entry,
  );
}

export function foldRoomActivity(
  state: RoomActivityState,
  frame: { botId?: string; event?: RuntimeEventLike },
): RoomActivityState {
  const event = frame.event;
  const botId = frame.botId;
  if (!event || !botId || !event.threadId) return state;
  const at = eventTime(event);
  const thread = state[event.threadId] ?? {};
  const current: RoomAgentActivity = thread[botId] ?? { status: "waiting", updatedAt: at, entries: [] };
  let next = current;

  switch (event.type) {
    case "turn.started":
      next = { ...current, status: "running", turnId: event.turnId, startedAt: at, updatedAt: at };
      break;
    case "item.started":
      if (event.itemType !== "tool") return state;
      next = {
        ...current,
        status: "running",
        startedAt: current.startedAt ?? at,
        updatedAt: at,
        entries: upsertEntry(current.entries, {
          id: event.itemId ?? `tool-${event.turnId ?? at}`,
          kind: "tool",
          title: event.title || "Working",
          status: "running",
          startedAt: at,
          updatedAt: at,
        }),
      };
      break;
    case "item.completed": {
      if (event.itemType !== "tool" || !event.itemId) return state;
      const entry = current.entries.find((item) => item.id === event.itemId);
      if (!entry) return state;
      next = {
        ...current,
        status: event.ok === false ? "failed" : "running",
        updatedAt: at,
        entries: upsertEntry(current.entries, {
          ...entry,
          status: event.ok === false ? "failed" : "completed",
          updatedAt: at,
        }),
      };
      break;
    }
    case "request.opened":
      next = {
        ...current,
        status: "approval",
        startedAt: current.startedAt ?? at,
        updatedAt: at,
        entries: upsertEntry(current.entries, {
          id: event.requestId ?? `approval-${event.turnId ?? at}`,
          kind: "approval",
          title: event.summary || event.tool || "Waiting for your response",
          status: "waiting",
          startedAt: at,
          updatedAt: at,
        }),
      };
      break;
    case "request.resolved": {
      if (!event.requestId) return state;
      const entry = current.entries.find((item) => item.id === event.requestId);
      if (!entry) return state;
      next = {
        ...current,
        status: "running",
        updatedAt: at,
        entries: upsertEntry(current.entries, {
          ...entry,
          title: event.source === "auto" ? `${entry.title} — Auto-approved` : entry.title,
          status: "completed",
          updatedAt: at,
        }),
      };
      break;
    }
    case "runtime.error":
      next = {
        ...current,
        status: "failed",
        updatedAt: at,
        entries: upsertEntry(current.entries, {
          id: `error-${event.eventId ?? event.turnId ?? at}`,
          kind: "error",
          title: event.message || event.summary || event.title || "Agent process failed",
          status: "failed",
          startedAt: at,
          updatedAt: at,
        }),
      };
      break;
    case "turn.completed": {
      const status = event.stopReason === "cancelled" ? "cancelled" : event.ok === false ? "failed" : "completed";
      next = {
        ...current,
        status,
        turnId: undefined,
        startedAt: undefined,
        updatedAt: at,
        entries: settleOpenEntries(current.entries, status, at),
      };
      break;
    }
    default:
      return state;
  }

  if (next === current) return state;
  return { ...state, [event.threadId]: { ...thread, [botId]: next } };
}
