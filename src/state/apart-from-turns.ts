import type { Bot, Group } from "./store";
import { sameJson } from "./same-json";
import { useStoreSelector } from "./store-select";

const BOT_TURN_FIELDS = [
  "messages", "activeLeafId", "hasMore", "awaitingThreadSnapshot", "switchingTo",
  "busy", "activity", "turnStartedAt", "waitingForTeammates", "unread", "tasks",
] as const satisfies readonly (keyof Bot)[];
const GROUP_TURN_FIELDS = [
  "messages", "hasMore", "unread", "lastReadMessageId", "busyBotId", "working", "turnStartedAt", "tasks", "usage", "queue", "holds", "heldMessages",
] as const satisfies readonly (keyof Group)[];

/** A bot as a reader sees it that never shows its conversation, threads, busy or unread state. */
export type BotApartFromTurns = Omit<Bot, (typeof BOT_TURN_FIELDS)[number]>;
export type GroupApartFromTurns = Omit<Group, (typeof GROUP_TURN_FIELDS)[number]>;

const botTurnFields: ReadonlySet<string> = new Set(BOT_TURN_FIELDS);
const groupTurnFields: ReadonlySet<string> = new Set(GROUP_TURN_FIELDS);

function sameApartFrom(a: object, b: object, skip: ReadonlySet<string>): boolean {
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!skip.has(key) && !sameJson(left[key], right[key])) return false;
  }
  return true;
}

function sameListApartFrom<T extends object>(a: readonly T[], b: readonly T[], skip: ReadonlySet<string>): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index] || sameApartFrom(item, b[index]!, skip)));
}

export function sameBotsApartFromTurns(a: readonly Bot[], b: readonly Bot[]): boolean {
  return sameListApartFrom(a, b, botTurnFields);
}

export function sameBotApartFromTurns(a: Bot | undefined, b: Bot | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameApartFrom(a, b, botTurnFields));
}

export function sameGroupsApartFromTurns(a: readonly Group[], b: readonly Group[]): boolean {
  return sameListApartFrom(a, b, groupTurnFields);
}

/** The bot list kept across turns: a turn changes nothing these readers draw, so it draws them nothing. */
export function useBotsApartFromTurns(): readonly BotApartFromTurns[] {
  return useStoreSelector((state) => state.bots, sameBotsApartFromTurns);
}

export function useGroupsApartFromTurns(): readonly GroupApartFromTurns[] {
  return useStoreSelector((state) => state.groups, sameGroupsApartFromTurns);
}

export function useBotApartFromTurns(pick: (bots: readonly Bot[]) => Bot | undefined): BotApartFromTurns | undefined {
  return useStoreSelector((state) => pick(state.bots), sameBotApartFromTurns);
}
