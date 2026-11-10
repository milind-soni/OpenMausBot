// On a team's Cloud the sidebar has two sides: "Just me", the person's own private conversations with each bot, and
// "Team", the conversations everyone who sees a bot or a group chat reads. Which side a conversation belongs to is the
// server's answer (`private` on the task), never the position of the switch.
import { useSyncExternalStore } from "react";
import { onTeamChats, ownChatOf, ownChatStarted, teamChats, type TeamChats } from "./team-chats";

export type TeamSide = "me" | "team";

type SideTask = { threadId: string; private?: unknown; sharedChat?: unknown; unread?: boolean; routineRunId?: unknown; archivedAt?: unknown };
type SideBot = { id: string; threadId: string; tasks?: SideTask[]; yourAccess?: string; defaultBot?: { person?: unknown }; hidden?: boolean; messages?: unknown[] };
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

/** The bot's shared chat, as the server names it; null for a bot that has none (a person's own MausBot). */
export const teamThreadOf = (bot: Pick<SideBot, "tasks" | "defaultBot">): string | null =>
  bot.defaultBot?.person ? null : bot.tasks?.find((task) => task.sharedChat === true && task.private !== true)?.threadId ?? null;

/** The bot's conversations of one side, for a list. */
export const tasksOfSide = <T extends SideTask>(bot: Pick<SideBot, "defaultBot"> & { tasks?: T[] }, side: TeamSide): T[] =>
  (bot.tasks ?? []).filter((task) => sideOfThread(bot, task.threadId) === side);

/** Whether the bot is listed on a side: under "Team" with its shared chat; under "Just me" when the person can chat
 * with it privately, or already has a conversation of their own with it. */
export function botOnSide(bot: SideBot, team: TeamChats, side: TeamSide): boolean {
  if (side === "team") return teamThreadOf(bot) !== null;
  return Boolean(bot.defaultBot?.person) || bot.yourAccess !== "view" || ownChatOf(bot, team) !== null;
}

/** A bot as one side lists it: that side's conversations only, and none of the other side's words in its preview. */
export function botForSide<T extends SideBot>(bot: T, side: TeamSide): T {
  const onScreenHere = sideOfThread(bot, bot.threadId) === side;
  return { ...bot, tasks: bot.tasks && tasksOfSide(bot, side), ...(onScreenHere || !bot.messages ? {} : { messages: [] }) } as T;
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

let unsaved: { teamId: string; side: TeamSide } | null = null;
let version = 0;
const listeners = new Set<() => void>();
const changed = () => { version++; for (const listener of listeners) listener(); };
onTeamChats(changed);

/** The side this person last chose on this device: "Just me" until they chose "Team". */
export function teamSide(team: TeamChats | null = teamChats(), storage: SideStorage | null = deviceStorage()): TeamSide {
  if (!team) return "me";
  const key = keyOf(team);
  try {
    if (key && storage) return storage.getItem(key) === "team" ? "team" : "me";
  } catch {}
  return unsaved?.teamId === team.teamId ? unsaved.side : "me";
}

export function setTeamSide(side: TeamSide, team: TeamChats | null = teamChats(), storage: SideStorage | null = deviceStorage()): void {
  if (!team || teamSide(team, storage) === side) return;
  const key = keyOf(team);
  unsaved = { teamId: team.teamId, side };
  try { if (key && storage) storage.setItem(key, side); } catch {}
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
  return team && teamSide(team) === "team" ? teamThreadOf(bot) : null;
}
