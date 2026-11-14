type UnreadBot = {
  unread?: boolean;
  tasks?: ReadonlyArray<{ unread?: boolean; routineRunId?: string; archivedAt?: number; openAsks?: number }> | null;
};

export function botShowsUnread(bot: UnreadBot): boolean {
  if (!bot.tasks?.length) return Boolean(bot.unread);
  return bot.tasks.some((task) => Boolean(task.unread) && !task.routineRunId && task.archivedAt === undefined);
}

/** The asks waiting on the person in a bot's conversations: on a team, the ones in their inbox. */
export function openAsksOf(bot: Pick<UnreadBot, "tasks">): number {
  return (bot.tasks ?? []).reduce((sum, task) => sum + (task.openAsks ?? 0), 0);
}

/** What one bot adds to the unread count: one while it shows unread, or each ask waiting in it when they are more. */
export function botUnreadCount(bot: UnreadBot): number {
  return Math.max(botShowsUnread(bot) ? 1 : 0, openAsksOf(bot));
}

const SHOWN_COUNT = /^\(\d+\) /;

/** Puts the count in front of the page's own title, in place of a count shown before. */
export function titleWithUnread(title: string, count: number): string {
  const own = title.replace(SHOWN_COUNT, "");
  return count > 0 ? `(${count}) ${own}` : own;
}

export function showBrowserUnread(count: number): void {
  document.title = titleWithUnread(document.title, count);
  // Chromium and Safari badge an installed web app's icon from this; other browsers lack the API.
  const badge = count > 0 ? navigator.setAppBadge?.(count) : navigator.clearAppBadge?.();
  void badge?.catch(() => {});
}
