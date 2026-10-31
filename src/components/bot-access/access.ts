import { accessFromVisibility, atLeast, GRANTED_LEVELS, type BotAccess, type BotAccessLevel, type GrantedLevel } from "../../../shared/bot-access";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { TeamPeople, TeamPerson } from "@/state/team-people";

const LEVEL_KEYS = {
  none: "botAccess.level.none",
  view: "botAccess.level.view",
  chat: "botAccess.level.chat",
  edit: "botAccess.level.edit",
} as const;

export const levelLabel = (level: BotAccessLevel): string => t(LEVEL_KEYS[level]);

/** The sharing this copy of the bot carries; an admin's copy from an older server carries only its visibility. */
export function accessOfBot(bot: Pick<Bot, "access" | "visibility">): BotAccess {
  return bot.access ?? accessFromVisibility(bot.visibility);
}

/** Whether this person may change the bot's sharing; off a team nobody shares a bot. */
export const canShare = (bot: Pick<Bot, "yourAccess">): boolean => bot.yourAccess === "edit";

/** The level a person gets when added: chat, or edit when everyone can already chat; none to give when everyone edits. */
export function levelWhenAdded(everyone: BotAccessLevel): GrantedLevel | null {
  return GRANTED_LEVELS.find((level) => atLeast(level, "chat") && !atLeast(everyone, level)) ?? null;
}

/** Admins and the owner can always edit, so they are never added; everyone else on the team not yet added can be. */
export function addablePeople(team: Pick<TeamPeople, "people">, access: BotAccess, owner: string | null, query: string): TeamPerson[] {
  const wanted = query.trim().toLowerCase();
  return team.people
    .filter((person) => person.role === "member" && person.email !== owner && !Object.hasOwn(access.people, person.email))
    .filter((person) => !wanted || person.name.toLowerCase().includes(wanted) || person.email.includes(wanted))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function withPerson(access: BotAccess, email: string, level: GrantedLevel | null): BotAccess {
  const people = { ...access.people };
  if (level) people[email] = level;
  else delete people[email];
  return { everyone: access.everyone, people };
}

export async function saveAccess(botId: string, access: BotAccess): Promise<Bot> {
  const answer = await api<{ bot: Bot }>(`/api/bots/${botId}/access`, { method: "PUT", body: JSON.stringify(access) });
  return answer.bot;
}
