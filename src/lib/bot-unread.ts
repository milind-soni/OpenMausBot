export function botShowsUnread(bot: {
  unread?: boolean;
  tasks?: ReadonlyArray<{ unread?: boolean; routineRunId?: string; archivedAt?: number }> | null;
}): boolean {
  if (!bot.tasks?.length) return Boolean(bot.unread);
  return bot.tasks.some((task) => Boolean(task.unread) && !task.routineRunId && task.archivedAt === undefined);
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
