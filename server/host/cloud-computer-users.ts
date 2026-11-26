// Whether a bot's own cloud computer is held by a running turn other than its bot's own, so it is never set aside by
// itself from under that turn. A turn takes a bot's computer through two resources, the bot's and the machine's. A
// holder in the bot's own thread is the bot itself; a holder whose bot cannot be told (a room's turn, with room jobs
// running side by side) may be any member, so it counts as another, unless it is the very turn that asks.
export interface CloudComputerUsersDeps {
  /** The running turn that holds this resource, if one does. */
  holder(resource: string): { threadId: string; generation: string } | undefined;
  /** The bot whose turn runs in this thread; null when the thread is not one bot's (a room's). */
  botOfThread(threadId: string): string | null;
}

export const computerResources = (owner: string, boxId: string): string[] => [`computer:box-bot:${owner}`, `computer:box:${boxId}`];

/** `asking`: the turn on whose behalf this is asked, which never counts against itself. */
export function usedByAnotherBot(owner: string, boxId: string, deps: CloudComputerUsersDeps, asking?: { threadId: string; generation: string }): boolean {
  return computerResources(owner, boxId).some((resource) => {
    const holder = deps.holder(resource);
    if (!holder) return false;
    if (asking && holder.threadId === asking.threadId && holder.generation === asking.generation) return false;
    return deps.botOfThread(holder.threadId) !== owner;
  });
}
