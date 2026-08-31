/** Same archive gates as the sidebar: a Chief stays reachable, and the
 * roster never drops its last active bot. */
export function archiveBlockedReason(
  bot: { chiefOfStaff?: boolean },
  activeCount: number,
): string | undefined {
  if (bot.chiefOfStaff) return "Choose another Chief of Staff first";
  if (activeCount <= 1) return "Keep at least one active bot";
  return undefined;
}
