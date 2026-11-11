// On a team's Cloud the sidebar has two sides: "Just me", the person's own private conversations with each bot, and
// "Team", the conversations everyone who sees a bot or a group chat reads. Which side a conversation belongs to is the
// server's answer (`private` on the task), never the position of the switch.
import { useSyncExternalStore } from "react";
import { accessFromVisibility, type BotAccess } from "../../shared/bot-access";
import { botOwner } from "../../shared/bot-owner";
import type { BotVisibility } from "../../shared/wire";
import { onTeamChats, ownChatOf, ownChatStarted, teamChats, type TeamChats } from "./team-chats";

export type TeamSide = "me" | "team";

type SideTask = { threadId: string; private?: unknown; sharedChat?: unknown; unread?: boolean; routineRunId?: unknown; archivedAt?: unknown };
type SharedBot = { yourAccess?: string; access?: BotAccess; visibility?: BotVisibility; createdBy?: string; reportsTo?: string; defaultBot?: { person?: string } };
type SideBot = SharedBot & { id: string; threadId: string; tasks?: SideTask[]; hidden?: boolean; messages?: unknown[] };
type SideGroup = { id: string; unread?: boolean };

/**
 * Security invariant: a conversation is "Just me" only when the server marked it private, or this page made it through
 * the server's private new-conversation route, or it is a chat with the person's own MausBot, which the server sends to
 * nobody else. Anything else, a conversation this page knows nothing of included, is the team's. So nothing ever says
 * "only you" over a composer whose words others can read.
 */
export function sideOfThread(bot: Pick<SideBot, "tasks" | "defaultBot">, threadId: string): TeamSide {
  if (bot.defaultBot?.person) return "me";
  const task = bot.tasks?.find((candidate) => candidate.threadId === threadId);
  return task?.sharedChat !== true && (task?.private === true || ownChatStarted(threadId)) ? "me" : "team";
}

/**
 * Whether anyone but whoever looks after the bot and the admins can use it, as far as this copy of it says. Someone who
 * can edit a bot is sent its sharing; anyone else who has the bot was given it, so it is shared with them.
 */
export function sharedWithOthers(bot: SharedBot): boolean {
  if (bot.defaultBot?.person) return false;
  if (bot.yourAccess === "view" || bot.yourAccess === "chat") return true;
  const access = bot.access ?? accessFromVisibility(bot.visibility);
  const owner = botOwner(bot);
  return access.everyone !== "none" || Object.keys(access.people).some((entry) => entry !== owner);
}

/** The side a conversation is listed on. A bot nobody else can use is under "Just me" whole, its main chat included:
 * "Team" lists only what is shared with someone. What the conversation says of its readers stays `sideOfThread`'s. */
export const listedSide = (bot: SharedBot & Pick<SideBot, "tasks">, threadId: string): TeamSide => (sharedWithOthers(bot) ? sideOfThread(bot, threadId) : "me");

/** The bot's shared chat, as the server names it; null for a bot that has none (a person's own MausBot). */
export const teamThreadOf = (bot: Pick<SideBot, "tasks" | "defaultBot">): string | null =>
  bot.defaultBot?.person ? null : bot.tasks?.find((task) => task.sharedChat === true && task.private !== true)?.threadId ?? null;

/** The bot's conversations of one side, for a list. */
export const tasksOfSide = <T extends SideTask>(bot: SharedBot & { tasks?: T[] }, side: TeamSide): T[] =>
  (bot.tasks ?? []).filter((task) => listedSide(bot, task.threadId) === side);

/** Whether the bot is listed on a side: under "Team" with its shared chat, when it is shared with someone; under
 * "Just me" when the person can chat with it privately, or already has a conversation of their own with it. */
export function botOnSide(bot: SideBot, team: TeamChats, side: TeamSide): boolean {
  if (side === "team") return teamThreadOf(bot) !== null && sharedWithOthers(bot);
  return Boolean(bot.defaultBot?.person) || bot.yourAccess !== "view" || ownChatOf(bot, team) !== null;
}

/** A bot as one side lists it: that side's conversations only, and nothing of the other side's on its row: no unread
 * mark, no working line, no words in its preview. */
export function botForSide<T extends SideBot>(bot: T, side: TeamSide): T {
  const onScreenHere = listedSide(bot, bot.threadId) === side;
  const tasks = tasksOfSide(bot, side);
  const elsewhere = onScreenHere ? {} : { busy: false, activity: undefined, waitingForTeammates: false, ...(bot.messages ? { messages: [] } : {}) };
  return { ...bot, tasks: bot.tasks && tasks, unread: tasks.some(marksUnread), ...elsewhere } as T;
}

const marksUnread = (task: SideTask) => Boolean(task.unread) && !task.routineRunId && task.archivedAt === undefined;

export interface TeamSideView<B, G> {
  /** False where there is nothing to switch between: off a team, or with one side empty. */
  switchable: boolean;
  bots: B[];
  groups: G[];
  /** This person's own unread state, per side. */
  unread: Record<TeamSide, boolean>;
}

/** What the sidebar lists on `side`. Off a team, everything, untouched. */
export function teamSideView<B extends SideBot, G extends SideGroup>(bots: B[], groups: G[], team: TeamChats | null, side: TeamSide): TeamSideView<B, G> {
  if (!team) return { switchable: false, bots, groups, unread: { me: false, team: false } };
  const shown = bots.filter((bot) => !bot.hidden);
  const listed = (which: TeamSide) => shown.filter((bot) => botOnSide(bot, team, which));
  const me = listed("me"), shared = listed("team");
  const switchable = me.length > 0 && shared.length + groups.length > 0;
  const unreadOn = (which: TeamSide) => shown.some((bot) => tasksOfSide(bot, which).some(marksUnread)) || (which === "team" && groups.some((group) => Boolean(group.unread)));
  const unread = { me: unreadOn("me"), team: unreadOn("team") };
  if (!switchable) return { switchable, bots, groups, unread };
  return { switchable, bots: (side === "me" ? me : shared).map((bot) => botForSide(bot, side)), groups: side === "team" ? groups : [], unread };
}

type SideStorage = Pick<Storage, "getItem" | "setItem">;
const deviceStorage = (): SideStorage | null => (typeof localStorage === "undefined" ? null : localStorage);
const keyOf = (team: TeamChats) => (team.person ? `omb.team-side.${team.teamId}.${team.person}` : null);

let shown: { page: string; side: TeamSide } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const listener of listeners) listener(); };
const pageOf = (team: TeamChats) => `${team.teamId}:${team.person ?? ""}`;
onTeamChats(() => {
  const team = teamChats();
  if (!team || pageOf(team) !== shown?.page) shown = null;
  changed();
});

/** The side this person last chose on this device: "Just me" until they chose "Team". */
export function savedTeamSide(team: TeamChats | null = teamChats(), storage: SideStorage | null = deviceStorage()): TeamSide {
  const key = team && keyOf(team);
  try {
    if (key && storage) return storage.getItem(key) === "team" ? "team" : "me";
  } catch {}
  return "me";
}

/** The side the sidebar shows: the one this page moved to, else the one the person last chose. */
export function teamSide(team: TeamChats | null = teamChats(), storage: SideStorage | null = deviceStorage()): TeamSide {
  if (!team) return "me";
  return shown?.page === pageOf(team) ? shown.side : savedTeamSide(team, storage);
}

/** Shows a side without keeping it: for a conversation that came on screen without the person asking for it. */
export function showTeamSide(side: TeamSide, team: TeamChats | null = teamChats()): void {
  if (!team || teamSide(team) === side) return;
  shown = { page: pageOf(team), side };
  changed();
}

/** The person's own choice, kept for next time: they pressed the switch, or opened a conversation of that side. */
export function setTeamSide(side: TeamSide, team: TeamChats | null = teamChats(), storage: SideStorage | null = deviceStorage()): void {
  if (!team) return;
  const key = keyOf(team), moves = teamSide(team, storage) !== side;
  try { if (key && storage && savedTeamSide(team, storage) !== side) storage.setItem(key, side); } catch {}
  if (!moves) return;
  shown = { page: pageOf(team), side };
  changed();
}

/** The team on screen and the side its sidebar shows. */
export function useTeamSide(): { team: TeamChats | null; side: TeamSide } {
  useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => version, () => version);
  const team = teamChats();
  return { team, side: teamSide(team) };
}

/** The shared chat, when opening this bot should land on "Team": the side the sidebar shows. */
export function teamThreadToOpen(bot: SideBot, team: TeamChats | null): string | null {
  return team && teamSide(team) === "team" && sharedWithOthers(bot) ? teamThreadOf(bot) : null;
}
