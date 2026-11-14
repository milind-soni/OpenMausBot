interface ThreadOwner {
  id: string;
  threadId: string;
  tasks?: Array<{ threadId: string }>;
}

const ownsThread = (owner: ThreadOwner, threadId: string) => owner.threadId === threadId || (owner.tasks ?? []).some((task) => task.threadId === threadId);

/** The ids on a card are written by a bot: act only on a bot or room the viewer has, and never on a thread that is another's. */
export function resolvedThreadTarget(
  target: { botId: string; threadId: string } | { groupId: string; threadId: string } | undefined,
  state: { bots: ThreadOwner[]; groups: ThreadOwner[] },
): { botId: string; threadId: string } | undefined {
  if (!target) return undefined;
  const owns = (owner: ThreadOwner) => ownsThread(owner, target.threadId);
  const bots = state.bots.filter(owns);
  const groups = state.groups.filter(owns);
  if ("groupId" in target) {
    const only = groups.length === 1 && groups[0]!.id === target.groupId && bots.length === 0;
    return only ? { botId: "", threadId: target.threadId } : undefined;
  }
  if (!state.bots.some((bot) => bot.id === target.botId)) return undefined;
  const unowned = bots.length === 0 && groups.length === 0;
  const ownedByIt = bots.length === 1 && bots[0]!.id === target.botId && groups.length === 0;
  return unowned || ownedByIt ? { botId: target.botId, threadId: target.threadId } : undefined;
}

export function existingThreadTarget(
  target: { botId: string; threadId: string } | null,
  state: { bots: ThreadOwner[]; groups: ThreadOwner[] },
): { botId: string; threadId: string } | undefined {
  const resolved = resolvedThreadTarget(target ?? undefined, state);
  return resolved && state.bots.some((bot) => ownsThread(bot, resolved.threadId)) ? resolved : undefined;
}
