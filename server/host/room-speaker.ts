/** A room's speaker entry, kept while its turn still holds the room. */
export interface RoomSpeaker {
  botId: string;
  name: string;
  color: string;
  since?: number;
}

/** Long enough for setup to reach the engine, short enough that a dead turn does not strand the room. */
export const ROOM_SPEAKER_GRACE_MS = 10_000;

interface SpeakerLiveness {
  /** The engine process this turn is running on. */
  engine(threadId: string): boolean;
  /** A turn the harness is still following live (`liveTurns`). */
  liveTurn(threadId: string): boolean;
  /** A turn that has ended but whose state is still settling. */
  settling(threadId: string): boolean;
  /** Queued work this room thread still owns. */
  operation(threadId: string): boolean;
  botBusy(botId: string): boolean;
  now(): number;
  graceMs?: number;
}

/** The speakers with no live turn, removed from `speakers` before `forget` is called for each. */
export function forgetStaleSpeakers(speakers: Map<string, RoomSpeaker>, live: SpeakerLiveness & { forget(threadId: string, speaker: RoomSpeaker): void }): Array<{ threadId: string; speaker: RoomSpeaker }> {
  const forgotten: Array<{ threadId: string; speaker: RoomSpeaker }> = [];
  for (const [threadId, speaker] of speakers) {
    const alive = live.engine(threadId) || live.liveTurn(threadId) || live.settling(threadId) || live.operation(threadId) || live.botBusy(speaker.botId)
      || speaker.since === undefined || live.now() - speaker.since < (live.graceMs ?? ROOM_SPEAKER_GRACE_MS);
    if (alive) continue;
    speakers.delete(threadId);
    forgotten.push({ threadId, speaker });
    live.forget(threadId, speaker);
  }
  return forgotten;
}

/** The room shape the registry reads: a group and the threads it owns. */
export interface RoomSpeakerGroup {
  id: string;
  threadId: string;
}

/** Queued work on a room thread, as the registry reads it. */
export interface RoomSpeakerOperation {
  cancelled: boolean;
  threadId: string;
}

export interface RoomSpeakersDeps {
  speakers: Map<string, RoomSpeaker>;
  operations: Map<string, Set<RoomSpeakerOperation>>;
  group(groupId: string): RoomSpeakerGroup | undefined;
  groupTasks(groupId: string): Array<{ threadId: string }>;
  groupByThread(threadId: string): RoomSpeakerGroup | undefined;
  engine(threadId: string): boolean;
  liveTurn(threadId: string): boolean;
  settling(threadId: string): boolean;
  botBusy(botId: string): boolean;
  now(): number;
  /** After an entry is removed: the room it held, and whoever still holds it once it is gone. */
  forget(threadId: string, groupId: string, speaker: RoomSpeaker, remaining: RoomSpeaker | undefined): void;
}

/** A room's speaker entries: who is speaking, what holds a room thread, and the sweep that drops leftovers. */
export function createRoomSpeakers(deps: RoomSpeakersDeps) {
  /** The speaker of a room's current thread, else one of its task threads. */
  const active = (groupId: string): RoomSpeaker | undefined => {
    const group = deps.group(groupId);
    if (!group) return undefined;
    const activeSpeaker = deps.speakers.get(group.threadId);
    if (activeSpeaker) return activeSpeaker;
    for (const task of deps.groupTasks(groupId)) {
      const speaker = deps.speakers.get(task.threadId);
      if (speaker) return speaker;
    }
    return undefined;
  };
  /** Whether a room thread is held by a speaker or by queued work still running on it. */
  const working = (groupId: string, threadId: string): boolean => {
    if (deps.speakers.has(threadId)) return true;
    const activeOps = deps.operations.get(groupId);
    if (activeOps) for (const op of activeOps) if (!op.cancelled && op.threadId === threadId) return true;
    return false;
  };
  /** Drop every speaker with no live turn behind it; returns how many were dropped. */
  const forgetStale = (): number => forgetStaleSpeakers(deps.speakers, {
    engine: deps.engine,
    liveTurn: deps.liveTurn,
    settling: deps.settling,
    operation: (threadId) => {
      const group = deps.groupByThread(threadId);
      return Boolean(group && [...(deps.operations.get(group.id) ?? [])].some((op) => !op.cancelled && op.threadId === threadId));
    },
    botBusy: deps.botBusy,
    now: deps.now,
    forget: (threadId, speaker) => {
      const group = deps.groupByThread(threadId);
      if (group) deps.forget(threadId, group.id, speaker, active(group.id));
    },
  }).length;
  return { active, working, forgetStale };
}
