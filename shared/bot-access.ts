// Who may see, chat with and change a Team Cloud bot. Four levels, lowest first; a person's level is the highest of what
// everyone in the team gets and what they were given. Admins and the bot's owner can always edit, so neither is listed.
import type { BotVisibility } from "./wire.ts";

export const BOT_ACCESS_LEVELS = ["none", "view", "chat", "edit"] as const;
export type BotAccessLevel = (typeof BOT_ACCESS_LEVELS)[number];
export type GrantedLevel = Exclude<BotAccessLevel, "none">;
export const GRANTED_LEVELS: readonly GrantedLevel[] = ["view", "chat", "edit"];

/** A Team Cloud bot's sharing. `everyone` is what every member of the team may do ("none": only the people added);
 * `people` gives each added person a level by lowercased address. An `@domain` entry, which only an older list carries,
 * covers that domain's addresses. */
export interface BotAccess {
  everyone: BotAccessLevel;
  people: Record<string, GrantedLevel>;
}

export interface BotAccessFields {
  /** Team Cloud only, and only on the copy sent to someone who can edit the bot: who may see, chat with and change it. */
  access?: BotAccess;
  /** Team Cloud only: what the person this copy was sent to may do with the bot. */
  yourAccess?: BotAccessLevel;
}

export const levelRank = (level: BotAccessLevel | undefined): number => BOT_ACCESS_LEVELS.indexOf(level ?? "none");
export const atLeast = (level: BotAccessLevel | undefined, wanted: BotAccessLevel): boolean => levelRank(level) >= levelRank(wanted);
export const higherLevel = (a: BotAccessLevel, b: BotAccessLevel): BotAccessLevel => (atLeast(a, b) ? a : b);
export const isAccessLevel = (value: unknown): value is BotAccessLevel => (BOT_ACCESS_LEVELS as readonly unknown[]).includes(value);

/** A bot nobody set sharing for: what its older visibility setting meant. Everyone could chat with an everyone bot, the
 * listed people with a listed one, and only admins (who edit every bot) with an admins-only one. */
export function accessFromVisibility(visibility: BotVisibility | undefined): BotAccess {
  if (visibility === undefined || visibility === "everyone") return { everyone: "chat", people: {} };
  if (visibility === "admins") return { everyone: "none", people: {} };
  return { everyone: "none", people: Object.fromEntries(visibility.people.map((entry) => [entry.trim().toLowerCase(), "chat" as const])) };
}

/** Who sees the bot at all: everyone when every member may at least view it, else its owner and the people added, else
 * admins only. */
export function visibilityFromAccess(access: BotAccess, owner: string | null): BotVisibility {
  if (access.everyone !== "none") return "everyone";
  const people = [...new Set([...(owner ? [owner] : []), ...Object.keys(access.people)])];
  return people.length ? { people } : "admins";
}

export function entryMatches(entry: string, email: string): boolean {
  return entry.startsWith("@") ? email.endsWith(entry) && email.length > entry.length : entry === email;
}

/** What this address may do by the bot's sharing alone, before admins and the owner. */
export function sharedLevel(access: BotAccess, email: string): BotAccessLevel {
  const address = email.trim().toLowerCase();
  let level = access.everyone;
  if (!address) return level;
  for (const [entry, granted] of Object.entries(access.people)) if (entryMatches(entry, address)) level = higherLevel(level, granted);
  return level;
}

export function sameAccess(a: BotAccess, b: BotAccess): boolean {
  const left = Object.entries(a.people), right = b.people;
  return a.everyone === b.everyone && left.length === Object.keys(right).length && left.every(([entry, level]) => right[entry] === level);
}

export interface AccessRequestCardField {
  /** Someone who can view a team bot asks the person this card is in front of to let them chat with it. */
  accessRequest?: { botId: string; botName: string; email: string; name: string };
}

export const ACCESS_REQUEST_OPTIONS = ["Allow", "Not now"] as const;
