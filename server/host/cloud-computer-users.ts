// Whether a bot's own cloud computer is held by a running turn of some other bot, so it is never replaced by itself from
// under that turn. A turn takes a bot's computer through two resources, the bot's and the machine's, and only a turn of
// that same bot binds them; a holder whose bot cannot be told (a room's turn, say) is that bot's own turn acting in
// the room, and does not stop a replacement its own silence asked for.
export interface CloudComputerUsersDeps {
  /** The running turn that holds this resource, if one does. */
  holder(resource: string): { threadId: string } | undefined;
  /** The bot whose turn runs in this thread; null when the thread is not one bot's (a room's). */
  botOfThread(threadId: string): string | null;
}

export const computerResources = (owner: string, boxId: string): string[] => [`computer:box-bot:${owner}`, `computer:box:${boxId}`];

export function usedByAnotherBot(owner: string, boxId: string, deps: CloudComputerUsersDeps): boolean {
  return computerResources(owner, boxId).some((resource) => {
    const holder = deps.holder(resource);
    if (!holder) return false;
    const bot = deps.botOfThread(holder.threadId);
    return bot !== null && bot !== owner;
  });
}
