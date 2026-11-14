import type { GroupGoalRunCardData } from "../../shared/group-goal-run";
import type { ConnectorCardData } from "../../shared/connector-card";
import { t } from "./i18n";
import type { LocaleKey } from "@/locales";
import type { DefaultBotFields } from "../../shared/default-bot";
import { hiddenFromSidebar, someoneElsesDefaultBot } from "./default-bot";

export const PINNED_SECTION_ID = "builtin:pinned";
export const CHANNELS_SECTION_ID = "builtin:channels";
export const BOT_CHATS_SECTION_ID = "builtin:bot-chats";
export const BOTS_SECTION_ID = "builtin:bots";
export const ATTENTION_SECTION_ID = "builtin:attention";
export const PINNED_THREADS_SECTION_ID = "builtin:pinned-threads";
export const TOOLS_SECTION_ID = "builtin:tools";

const USER_SECTION_PREFIX = "section:";

export type SidebarSectionId = string;
export type SectionDropPlace = "before" | "after";
export type SidebarDensityMode = "comfortable" | "icons";

const GOAL_RUN_PREVIEW_LABEL = {
  working: "routines.goal.working",
  completed: "routines.goal.completed",
  "needs-input": "routines.goal.needs-input",
  blocked: "routines.goal.blocked",
  "limit-reached": "routines.goal.limit-reached",
  paused: "routines.goal.paused",
  stopped: "routines.goal.stopped",
  failed: "routines.goal.failed",
} satisfies Record<GroupGoalRunCardData["status"], LocaleKey>;

export type SidebarBot = DefaultBotFields & {
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
  if (id === CHANNELS_SECTION_ID) return "Group chats";
  if (id === BOT_CHATS_SECTION_ID) return "Bot threads";
  if (id === BOTS_SECTION_ID) return "Bots";
  return userSectionName(id) ?? id;
}

export function sidebarGoalRunPreview(run: GroupGoalRunCardData): string {
  const detail = run.detail?.replace(/\s+/g, " ").trim();
  const goal = run.goal.replace(/\s+/g, " ").trim();
  const summary = detail || goal;
  const label = t(GOAL_RUN_PREVIEW_LABEL[run.status]);
  return summary ? `${label}: ${summary}` : label;
}

export type SidebarConnectorPreviewKey = "connectors.card.connected" | "connectors.card.waiting" | "connectors.card.connectSecurely";

export function sidebarConnectorPreview(
  connector: Pick<ConnectorCardData, "label" | "status" | "dismissed">,
  say: (key: SidebarConnectorPreviewKey) => string,
): string {
  if (connector.dismissed) return connector.label;
  const key: SidebarConnectorPreviewKey = connector.status === "connected"
    ? "connectors.card.connected"
    : connector.status === "authorizing" ? "connectors.card.waiting" : "connectors.card.connectSecurely";
  return `${connector.label} · ${say(key)}`;
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

export function pinnedCircleThreadListVisible(
  circles: boolean,
  density: SidebarDensityMode,
  pinnedCount: number,
): boolean {
  return circles && density !== "icons" && pinnedCount > 0;
}

export function partitionSidebarBots<T extends SidebarBot>(
  bots: T[],
  options?: { universalPins?: boolean; viewerEmail?: string | null; welcoming?: string | null; searching?: boolean },
) {
  const universalPins = options?.universalPins === true;
  // A search also finds the viewer's own MausBot when it is hidden from the sidebar, so it can always be reached.
  const listed = (bot: T) => !hiddenFromSidebar(bot, options?.viewerEmail) || (options?.searching === true && Boolean(bot.defaultBot) && !someoneElsesDefaultBot(bot, options.viewerEmail));
  const visible = bots.filter((bot) => !bot.hidden && listed(bot) && bot.id !== options?.welcoming);
  // The pin flag is the server's, the same on every client. Only the main Chief keeps its own top slot when pins are
  // not universal (a device's layout choice); a pinned Chief of a group is listed with the other pinned bots.
  const pinnedBots = visible.filter((bot) => Boolean(bot.pinned) && (universalPins || !bot.chiefOfStaff || Boolean(bot.section)));
  const pinnedIds = new Set(pinnedBots.map((bot) => bot.id));
  const unsectionedChief = visible.find((bot) => bot.chiefOfStaff && !bot.section && !pinnedIds.has(bot.id)) ?? null;
  const sectionChiefs = visible.filter((bot) => bot.chiefOfStaff && Boolean(bot.section) && !pinnedIds.has(bot.id));
  const sectionedBots = visible.filter(
    (bot) => !bot.chiefOfStaff && Boolean(bot.section) && !pinnedIds.has(bot.id),
  );
  // A search can list two unsectioned Chiefs (the viewer's hidden MausBot and a shared Chief); the second is a bot row.
  const unsectionedBots = visible.filter(
    (bot) => (!bot.chiefOfStaff || (options?.searching === true && bot !== unsectionedChief)) && !bot.section && !pinnedIds.has(bot.id),
  );
  return { unsectionedChief, pinnedBots, sectionChiefs, sectionedBots, unsectionedBots };
}

export function withPrimaryTile<T extends SidebarBot>(parts: ReturnType<typeof partitionSidebarBots<T>>, defaultBotId: string | undefined) {
  const primary = parts.unsectionedChief
    ?? parts.pinnedBots.find((bot) => bot.chiefOfStaff && !bot.section)
    ?? [...parts.pinnedBots, ...parts.unsectionedBots].find((bot) => bot.id === defaultBotId)
    ?? null;
  if (!primary) return { ...parts, primary };
  const others = (bots: T[]) => bots.filter((bot) => bot.id !== primary.id);
  return { ...parts, primary, unsectionedChief: null, pinnedBots: others(parts.pinnedBots), unsectionedBots: others(parts.unsectionedBots) };
}

/** Bots that are working or waiting on the person move to the top of their own list (pinned, main, each department),
 * keeping the person's order among them; the rest follow in that same order. Only how the list is shown changes. */
export function activeBotsFirst<T>(parts: { pinnedBots: T[]; sectionedBots: T[]; unsectionedBots: T[] }, active: (bot: T) => boolean) {
  const first = (bots: T[]) => {
    const flags = bots.map(active);
    return [...bots.filter((_, index) => flags[index]), ...bots.filter((_, index) => !flags[index])];
  };
  return { pinnedBots: first(parts.pinnedBots), sectionedBots: first(parts.sectionedBots), unsectionedBots: first(parts.unsectionedBots) };
}

export function partitionSidebarGroups<T extends SidebarGroup>(groups: T[]) {
  const botChats = groups.filter((group) => Boolean(group.dm));
  const rooms = groups.filter((group) => !group.dm);
  const sectionedRooms = rooms.filter((group) => Boolean(group.section));
  const unsectionedRooms = rooms.filter((group) => !group.section);
  return { botChats, sectionedRooms, unsectionedRooms };
}

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

export const SIMPLE_FIRST_SECTION_IDS: readonly SidebarSectionId[] = [PINNED_SECTION_ID, BOTS_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID];

export function simpleSidebarSections(ids: SidebarSectionId[]): SidebarSectionId[] {
  return [
    ...SIMPLE_FIRST_SECTION_IDS.filter((id) => ids.includes(id)),
    ...ids.filter((id) => !SIMPLE_FIRST_SECTION_IDS.includes(id)),
  ];
}

export function simpleOrderedSections(ordered: SidebarSectionId[], simpleSaved: SidebarSectionId[]): SidebarSectionId[] {
  return orderedSidebarSections(simpleSidebarSections(ordered), simpleSaved);
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
