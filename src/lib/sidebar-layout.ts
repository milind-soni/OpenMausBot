import type { GroupGoalRunCardData } from "../../shared/group-goal-run";

export const PINNED_SECTION_ID = "builtin:pinned";
export const CHANNELS_SECTION_ID = "builtin:channels";
export const BOT_CHATS_SECTION_ID = "builtin:bot-chats";
export const BOTS_SECTION_ID = "builtin:bots";

const USER_SECTION_PREFIX = "section:";

export type SidebarSectionId = string;
export type SectionDropPlace = "before" | "after";
export type SidebarDensityMode = "comfortable" | "compact" | "icons";

const GOAL_RUN_PREVIEW_LABEL = {
  working: "Working",
  completed: "Completed",
  "needs-input": "Needs your input",
  blocked: "Blocked",
  "limit-reached": "Turn limit reached",
  stopped: "Stopped",
  failed: "Failed",
} satisfies Record<GroupGoalRunCardData["status"], string>;

export type SidebarBot = {
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function userSectionId(name: string): SidebarSectionId {
  return `${USER_SECTION_PREFIX}${name}`;
}

export function userSectionName(id: SidebarSectionId): string | null {
  if (!id.startsWith(USER_SECTION_PREFIX)) return null;
  return id.slice(USER_SECTION_PREFIX.length);
}

export function sidebarSectionLabel(id: SidebarSectionId): string {
  if (id === PINNED_SECTION_ID) return "Pinned";
  if (id === CHANNELS_SECTION_ID) return "Channels";
  if (id === BOT_CHATS_SECTION_ID) return "Bot Chats";
  if (id === BOTS_SECTION_ID) return "Bots";
  return userSectionName(id) ?? id;
}

export function sidebarGoalRunPreview(run: GroupGoalRunCardData): string {
  const detail = run.detail?.replace(/\s+/g, " ").trim();
  const goal = run.goal.replace(/\s+/g, " ").trim();
  const summary = detail || goal;
  const label = GOAL_RUN_PREVIEW_LABEL[run.status];
  return summary ? `${label}: ${summary}` : label;
}

export function sidebarLayoutInteractive(density: SidebarDensityMode, query: string): boolean {
  return density !== "icons" && query.trim().length === 0;
}

export function sidebarSectionCollapsed(
  id: SidebarSectionId,
  collapsedIds: SidebarSectionId[],
  density: SidebarDensityMode,
  query: string,
): boolean {
  return sidebarLayoutInteractive(density, query) && collapsedIds.includes(id);
}

/** Pinned bots are a virtual view. Their saved section is left untouched so
 * unpinning returns them to the context they came from. */
export function partitionSidebarBots<T extends SidebarBot>(bots: T[]) {
  const visible = bots.filter((bot) => !bot.hidden);
  const unsectionedChief = visible.find((bot) => bot.chiefOfStaff && !bot.section) ?? null;
  const pinnedBots = visible.filter((bot) => !bot.chiefOfStaff && Boolean(bot.pinned));
  const pinnedIds = new Set(pinnedBots.map((bot) => bot.id));
  const sectionChiefs = visible.filter((bot) => bot.chiefOfStaff && Boolean(bot.section));
  const sectionedBots = visible.filter(
    (bot) => !bot.chiefOfStaff && Boolean(bot.section) && !pinnedIds.has(bot.id),
  );
  const unsectionedBots = visible.filter(
    (bot) => !bot.chiefOfStaff && !bot.section && !pinnedIds.has(bot.id),
  );
  return { unsectionedChief, pinnedBots, sectionChiefs, sectionedBots, unsectionedBots };
}

/** Bot-to-bot DMs are also a virtual view. We do not rewrite their persisted
 * context, because that context still participates in comms visibility. */
export function partitionSidebarGroups<T extends SidebarGroup>(groups: T[]) {
  const botChats = groups.filter((group) => Boolean(group.dm));
  const rooms = groups.filter((group) => !group.dm);
  const sectionedRooms = rooms.filter((group) => Boolean(group.section));
  const unsectionedRooms = rooms.filter((group) => !group.section);
  return { botChats, sectionedRooms, unsectionedRooms };
}

/** Restore saved positions while inserting newly visible buckets at their
 * natural position instead of always appending them. */
export function orderedSidebarSections(
  present: SidebarSectionId[],
  savedOrder: SidebarSectionId[],
): SidebarSectionId[] {
  const visible = unique(present);
  const visibleSet = new Set(visible);
  const result = unique(savedOrder).filter((id) => visibleSet.has(id));
  if (result.length === 0) return visible;

  for (const id of visible) {
    if (result.includes(id)) continue;
    const naturalIndex = visible.indexOf(id);
    const naturalPredecessors = visible.slice(0, naturalIndex).reverse();
    const naturalSuccessors = visible.slice(naturalIndex + 1);
    const predecessor = naturalPredecessors.find((candidate) => result.includes(candidate));
    const successor = naturalSuccessors.find((candidate) => result.includes(candidate));
    const predecessorIndex = predecessor ? result.indexOf(predecessor) : -1;
    const successorIndex = successor ? result.indexOf(successor) : -1;

    if (predecessorIndex >= 0 && (successorIndex < 0 || predecessorIndex < successorIndex)) {
      result.splice(predecessorIndex + 1, 0, id);
    } else if (successorIndex >= 0) {
      result.splice(successorIndex, 0, id);
    } else {
      result.push(id);
    }
  }
  return result;
}

export function moveSection(
  ids: SidebarSectionId[],
  id: SidebarSectionId,
  direction: -1 | 1,
): SidebarSectionId[] {
  const index = ids.indexOf(id);
  const destination = index + direction;
  if (index < 0 || destination < 0 || destination >= ids.length) return ids;
  const result = [...ids];
  const [moved] = result.splice(index, 1);
  result.splice(destination, 0, moved!);
  return result;
}

export function placeSection(
  ids: SidebarSectionId[],
  fromId: SidebarSectionId,
  targetId: SidebarSectionId,
  place: SectionDropPlace,
): SidebarSectionId[] {
  if (fromId === targetId || !ids.includes(fromId) || !ids.includes(targetId)) return ids;
  const result = ids.filter((id) => id !== fromId);
  let destination = result.indexOf(targetId);
  if (place === "after") destination += 1;
  result.splice(destination, 0, fromId);
  return result;
}

/** Preserve temporarily empty sections in the saved order so their position
 * returns when a bot or channel is later assigned to them again. */
export function mergeSectionOrder(
  savedOrder: SidebarSectionId[],
  visibleOrder: SidebarSectionId[],
): SidebarSectionId[] {
  const saved = unique(savedOrder);
  const result = unique(visibleOrder);
  const included = new Set(result);

  for (let savedIndex = 0; savedIndex < saved.length; savedIndex += 1) {
    const id = saved[savedIndex]!;
    if (included.has(id)) continue;
    let destination = result.length;
    let foundPredecessor = false;
    for (let previous = savedIndex - 1; previous >= 0; previous -= 1) {
      const previousPosition = result.indexOf(saved[previous]!);
      if (previousPosition >= 0) {
        destination = previousPosition + 1;
        foundPredecessor = true;
        break;
      }
    }
    if (!foundPredecessor) {
      for (let next = savedIndex + 1; next < saved.length; next += 1) {
        const nextPosition = result.indexOf(saved[next]!);
        if (nextPosition >= 0) {
          destination = nextPosition;
          break;
        }
      }
    }
    result.splice(destination, 0, id);
    included.add(id);
  }
  return result;
}

export function sameSectionOrder(a: SidebarSectionId[], b: SidebarSectionId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
