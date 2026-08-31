/** Same name/title/preview match as the sidebar search box. */
export function menuBarBotMatches(
  bot: { name: string; title?: string },
  query: string,
  preview: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    bot.name.toLowerCase().includes(needle) ||
    (bot.title ?? "").toLowerCase().includes(needle) ||
    preview.toLowerCase().includes(needle)
  );
}
