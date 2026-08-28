/** Built-in Projects row (unsectioned rooms). Id stays `channels` so saved
 * collapse/order keys keep working. */
export const CHANNELS_SECTION_ID = "channels";
export const PROJECTS_SECTION = "Projects";

/** Built-in bucket for bot⇄bot DMs. Displayed from `group.dm`, not from a user-created section name. */
export const BOT_CHATS_SECTION_ID = "bot-chats";
export const BOT_CHATS_SECTION = "Bot Chats";

/** Built-in bucket for pinned bots. Displayed from `bot.pinned`, not a user section name. */
export const PINNED_SECTION_ID = "pinned";

/** Unsectioned, unpinned bots. */
export const BOTS_SECTION_ID = "bots";

/** Footer tools (Team map, routines, connected apps). Profile + settings stay visible. */
export const MORE_NAV_ID = "more";

/** Default list order for built-in buckets. User sections follow unless the user moved them. */
export const DEFAULT_BUILTIN_SECTION_ORDER = [
  PINNED_SECTION_ID,
  CHANNELS_SECTION_ID,
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
] as const;

export function sidebarSectionLabel(id: string): string {
  if (id === PINNED_SECTION_ID) return "Pinned";
  if (id === CHANNELS_SECTION_ID) return PROJECTS_SECTION;
  if (id === BOT_CHATS_SECTION_ID) return BOT_CHATS_SECTION;
  if (id === BOTS_SECTION_ID) return "Bots";
  return id;
}

export function isReservedSectionId(id: string): boolean {
  return (
    id === PINNED_SECTION_ID ||
    id === CHANNELS_SECTION_ID ||
    id === BOT_CHATS_SECTION_ID ||
    id === BOTS_SECTION_ID
  );
}

export type SidebarMember = {
  id: string;
  chiefOfStaff?: boolean;
  section?: string;
  pinned?: boolean;
  hidden?: boolean;
};

export type SidebarGroup = {
  id: string;
  section?: string;
  dm?: boolean;
};

/** Bot⇄bot DMs always sit in the built-in Bot Chats bucket, even if they
 * were previously filed under the sender's team section (Agents). */
export function partitionSidebarGroups<T extends SidebarGroup>(groups: T[]) {
  const botChats = groups.filter((group) => Boolean(group.dm) || group.section === BOT_CHATS_SECTION);
  const botChatIds = new Set(botChats.map((group) => group.id));
  const rooms = groups.filter((group) => !botChatIds.has(group.id));
  const sectionedRooms = rooms.filter((group) => Boolean(group.section));
  const unsectionedRooms = rooms.filter((group) => !group.section);
  return { botChats, sectionedRooms, unsectionedRooms };
}

export function orderedSectionNames(discovered: string[], savedOrder: string[]): string[] {
  const unique = [...new Set(discovered.filter(Boolean))];
  const known = savedOrder.filter((name) => unique.includes(name));
  const rest = unique.filter((name) => !known.includes(name));
  return [...known, ...rest];
}

/** Mix built-in buckets and user sections. Saved order wins; anything new
 * (Pinned, Projects, a newly created team) inserts at its default index
 * relative to the current list instead of dumping at the end. */
export function orderedSidebarSections(present: string[], savedOrder: string[]): string[] {
  const unique = [...new Set(present.filter(Boolean))];
  const known = savedOrder.filter((id) => unique.includes(id));
  if (known.length === 0) return unique;
  const result = [...known];
  for (const id of unique) {
    if (result.includes(id)) continue;
    const defaultIndex = unique.indexOf(id);
    let insertAt = result.length;
    for (let i = 0; i < result.length; i++) {
      if (unique.indexOf(result[i]!) > defaultIndex) {
        insertAt = i;
        break;
      }
    }
    result.splice(insertAt, 0, id);
  }
  return result;
}

export function moveSection(names: string[], name: string, direction: -1 | 1): string[] {
  const index = names.indexOf(name);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= names.length) return names;
  const next = names.slice();
  const [moved] = next.splice(index, 1);
  next.splice(nextIndex, 0, moved);
  return next;
}

export type SectionDropPlace = "before" | "after";

/** Drop `fromId` before or after `targetId`. Same-item drops are a no-op. */
export function placeSection(
  ids: string[],
  fromId: string,
  targetId: string,
  place: SectionDropPlace,
): string[] {
  if (fromId === targetId) return ids;
  const from = ids.indexOf(fromId);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0) return ids;
  const next = ids.filter((id) => id !== fromId);
  let insertAt = next.indexOf(targetId);
  if (insertAt < 0) return ids;
  if (place === "after") insertAt += 1;
  next.splice(insertAt, 0, fromId);
  return next;
}

export function sameSectionOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Apply a new visible order and put empty sections back after the neighbor
 * they used to follow, instead of dropping them from the saved list. */
export function mergeSectionOrder(saved: string[], visibleOrder: string[]): string[] {
  const result = visibleOrder.filter(Boolean);
  const inResult = new Set(result);
  for (let savedIndex = 0; savedIndex < saved.length; savedIndex++) {
    const id = saved[savedIndex];
    if (!id || inResult.has(id)) continue;
    let insertAt = result.length;
    for (let i = savedIndex - 1; i >= 0; i--) {
      const pos = result.indexOf(saved[i]!);
      if (pos >= 0) {
        insertAt = pos + 1;
        break;
      }
    }
    result.splice(insertAt, 0, id);
    inResult.add(id);
  }
  return result;
}

/** Pinned non-chief bots sit directly under the unsectioned Chief of Staff. */
export function partitionSidebarBots<T extends SidebarMember>(bots: T[]) {
  const visible = bots.filter((bot) => !bot.hidden);
  const unsectionedChief = visible.find((bot) => bot.chiefOfStaff && !bot.section) ?? null;
  const pinnedUnderChief = visible.filter((bot) => !bot.chiefOfStaff && Boolean(bot.pinned));
  const pinnedIds = new Set(pinnedUnderChief.map((bot) => bot.id));
  const sectionChiefs = visible.filter((bot) => bot.chiefOfStaff && bot.section);
  const sectionedBots = visible.filter(
    (bot) => !bot.chiefOfStaff && bot.section && !pinnedIds.has(bot.id),
  );
  const unsectionedBots = visible.filter(
    (bot) => !bot.chiefOfStaff && !bot.section && !pinnedIds.has(bot.id),
  );
  return { unsectionedChief, pinnedUnderChief, sectionChiefs, sectionedBots, unsectionedBots };
}
