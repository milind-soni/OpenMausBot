/** The switcher filters the existing sidebar list. Null = All bots. */

export function botInActiveTeam(
  bot: { teamId?: string | null; hidden?: boolean },
  teamId: string | null,
): boolean {
  if (bot.hidden) return false;
  if (!teamId) return true;
  return bot.teamId === teamId;
}

export function groupInActiveTeam(
  group: { teamId?: string | null; memberIds: string[]; dm?: boolean },
  bots: Array<{ id: string; teamId?: string | null; hidden?: boolean }>,
  teamId: string | null,
): boolean {
  if (!teamId) return true;
  if (group.teamId) return group.teamId === teamId;
  const members = group.memberIds
    .map((id) => bots.find((bot) => bot.id === id))
    .filter((bot): bot is NonNullable<typeof bot> => bot != null && !bot.hidden);
  return members.length > 0 && members.every((bot) => bot.teamId === teamId);
}

/** A late or failed /api/teams/active response must not rewind a newer switch. */
export function isCurrentTeamActivation(
  currentActiveTeamId: string | null,
  requestedTeamId: string | null,
): boolean {
  return currentActiveTeamId === requestedTeamId;
}

export function firstVisibleSelection(
  bots: Array<{ id: string; teamId?: string | null; hidden?: boolean; chiefOfStaff?: boolean }>,
  groups: Array<{ id: string; teamId?: string | null; memberIds: string[]; dm?: boolean }>,
  teamId: string | null,
  currentId?: string,
): string {
  const visibleBots = bots.filter((bot) => botInActiveTeam(bot, teamId));
  const visibleGroups = groups.filter((group) => groupInActiveTeam(group, bots, teamId));
  if (
    currentId &&
    (visibleBots.some((bot) => bot.id === currentId) || visibleGroups.some((group) => group.id === currentId))
  ) {
    return currentId;
  }
  const chief = visibleBots.find((bot) => bot.chiefOfStaff);
  return chief?.id ?? visibleGroups[0]?.id ?? visibleBots[0]?.id ?? "";
}

export function searchHitInActiveTeam(
  hit: { botId?: string; groupId?: string },
  bots: Array<{ id: string; teamId?: string | null; hidden?: boolean }>,
  groups: Array<{ id: string; teamId?: string | null; memberIds: string[]; dm?: boolean }>,
  teamId: string | null,
): boolean {
  if (!teamId) return true;
  if (hit.botId) {
    const bot = bots.find((candidate) => candidate.id === hit.botId);
    return Boolean(bot && botInActiveTeam(bot, teamId));
  }
  if (hit.groupId) {
    const group = groups.find((candidate) => candidate.id === hit.groupId);
    return Boolean(group && groupInActiveTeam(group, bots, teamId));
  }
  return false;
}
