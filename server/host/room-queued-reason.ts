/** What the queue can see of a room and the turns holding it. */
export interface RoomQueuedReasonDeps {
  group(groupId: string): { id: string; name: string; threadId: string } | undefined;
  /** The room a thread belongs to, its own thread or one of its task threads. */
  roomOfThread(threadId: string): { id: string; name: string } | undefined;
  speaker(threadId: string): { botId: string; name: string } | undefined;
  speakers(): Iterable<[string, { botId: string; name: string }]>;
}

/** The live store and speaker map, as `roomReasonFor` reads them. */
export interface RoomReasonSource {
  group(groupId: string): { id: string; name: string; threadId: string } | undefined;
  groupByThread(threadId: string): { id: string; name: string } | undefined;
  speakers: ReadonlyMap<string, { botId: string; name: string }>;
}

/** The `roomReason` dependency of `createQueuedReason`, over a store and the server's room speakers. */
export function roomReasonFor(source: RoomReasonSource): (node: { groupId?: string; botId: string; threadId: string }) => string | undefined {
  return (node) => roomQueuedReason(node, {
    group: (id) => source.group(id),
    roomOfThread: (id) => source.groupByThread(id),
    speaker: (id) => source.speakers.get(id),
    speakers: () => source.speakers,
  });
}

/** A busy room node is held either by a speaker in its own thread, or by its own teammate speaking somewhere else. Name
 * that holder; a room reservation with no turn behind it is not enough, and the caller's generic line covers the rest. */
export function roomQueuedReason(node: { groupId?: string; botId: string; threadId: string }, deps: RoomQueuedReasonDeps): string | undefined {
  if (!node.groupId) return undefined;
  const group = deps.group(node.groupId);
  if (!group) return undefined;
  const here = deps.speaker(node.threadId);
  if (here) return `waiting for ${here.name} to finish its turn in this room`;
  for (const [threadId, speaker] of deps.speakers()) {
    if (speaker.botId !== node.botId) continue;
    const room = deps.roomOfThread(threadId);
    // The other room's name stays out: whoever reads this line may not be in that room.
    return !room || room.id === group.id
      ? `waiting for ${speaker.name} to finish its turn in this room`
      : `waiting for ${speaker.name} to finish its turn in another room`;
  }
  return undefined;
}
