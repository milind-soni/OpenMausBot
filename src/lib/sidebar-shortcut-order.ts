/**
 * The bots that ⌘1…⌘9 and ⌘⇧[ / ⌘⇧] step through, in the order the sidebar shows them. Sections, a custom bot
 * order, collapsed sections, pinned tiles and a search all change that order, so it is read from the rendered rows
 * instead of being rebuilt from `state.bots`.
 */
export function shownBotIds(root: ParentNode | null | undefined): string[] {
  if (!root) return [];
  const ids = [...root.querySelectorAll<HTMLElement>("[data-sidebar-bot-row]")].map((row) => row.dataset.sidebarBotRow ?? "");
  return [...new Set(ids.filter(Boolean))];
}

/** `bots` in the sidebar's order; with no sidebar on screen, `bots` as they are. */
export function shortcutBots<T extends { id: string }>(bots: readonly T[], shownIds: readonly string[]): T[] {
  if (shownIds.length === 0) return [...bots];
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  return shownIds.flatMap((id) => byId.get(id) ?? []);
}

/**
 * The bot ⌘⇧] (`step` 1) or ⌘⇧[ (`step` -1) opens. A selected bot that is not in `bots`, such as one in a
 * collapsed section, counts as standing just outside the list: ] opens the first bot and [ the last.
 */
export function nextShortcutBot<T extends { id: string }>(bots: readonly T[], selectedId: string | null | undefined, step: 1 | -1): T | undefined {
  if (bots.length === 0) return undefined;
  const index = bots.findIndex((bot) => bot.id === selectedId);
  if (index === -1) return step > 0 ? bots[0] : bots.at(-1);
  return bots[(index + step + bots.length) % bots.length];
}
