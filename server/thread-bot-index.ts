// Which bot a thread belongs to, remembered between lookups. Bots and their threads change in place all over the
// store, so nothing here is told of a change: a remembered answer is given only after it is checked against the bot
// list as it is now, and anything else is found by the scan.

interface ThreadOwner { threadId: string; tasks?: ReadonlyArray<{ threadId: string }> }

const owns = (bot: ThreadOwner, threadId: string): boolean =>
  bot.threadId === threadId || Boolean(bot.tasks?.some((task) => task.threadId === threadId));

/** The first bot whose current thread or any of whose threads is `threadId`. */
export function scanBotByThread<Bot extends ThreadOwner>(bots: readonly Bot[], threadId: string): Bot | null {
  return bots.find((bot) => owns(bot, threadId)) ?? null;
}

const REMEMBERED_MAX = 50_000;

/**
 * `find` answers as scanBotByThread does. A remembered bot is returned only while it sits at the same place in the
 * same list and still owns the thread; a list replaced or resized forgets everything. A thread no bot owns (a room's)
 * is scanned for every time.
 * Known open risk: two bots owning one thread id, the earlier one gaining it after the later one was remembered, would
 * get the later bot until the list changes. Thread ids are random, so that takes one written into two bots by hand.
 */
export function createThreadBotIndex<Bot extends ThreadOwner>() {
  const remembered = new Map<string, { bot: Bot; at: number }>();
  let list: readonly Bot[] | null = null, length = 0;
  return {
    find(bots: readonly Bot[], threadId: string): Bot | null {
      if (bots !== list || bots.length !== length) {
        remembered.clear();
        list = bots;
        length = bots.length;
      }
      const held = remembered.get(threadId);
      if (held && bots[held.at] === held.bot && owns(held.bot, threadId)) return held.bot;
      const at = bots.findIndex((bot) => owns(bot, threadId));
      if (at < 0) {
        remembered.delete(threadId);
        return null;
      }
      if (remembered.size >= REMEMBERED_MAX) remembered.clear();
      remembered.set(threadId, { bot: bots[at]!, at });
      return bots[at]!;
    },
  };
}
