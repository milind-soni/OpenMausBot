export const BOT_ROW_DRAG_TYPE = "application/x-openmausbot-sidebar-bot";

/** Where a dragged bot lands against the row under the pointer: above it, below it, or with it in a new department. */
export type BotDropPlace = "before" | "after" | "group";

/** The rows a bot can be dragged among, each in the order shown: the bots in no department under `""`, and each
 * department's under its name. */
export type BotLists = ReadonlyMap<string, readonly string[]>;

export type BotDrop =
  | { kind: "row"; botId: string; place: BotDropPlace }
  | { kind: "end"; list: string };

export type BotMove =
  /** The bot goes to `section` (`""`: no department), and that list's rows take `order`. */
  | { kind: "move"; section: string; order: string[] }
  /** The first bot stays where the second was dropped on it; both start a department. */
  | { kind: "group"; botIds: [string, string] };

/** The middle half of a row starts a department with it, where `canGroup`; the rest places the bot above or below. */
export function botDropPlace(offset: number, height: number, canGroup: boolean): BotDropPlace {
  const fraction = height > 0 ? offset / height : 0.5;
  if (canGroup && fraction > 0.25 && fraction < 0.75) return "group";
  return fraction < 0.5 ? "before" : "after";
}

export function botListOf(lists: BotLists, botId: string): string | undefined {
  for (const [list, ids] of lists) if (ids.includes(botId)) return list;
  return undefined;
}

export function sameBotDrop(a: BotDrop | null, b: BotDrop | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "row") return b.kind === "row" && a.botId === b.botId && a.place === b.place;
  return b.kind === "end" && a.list === b.list;
}

function placed(lists: BotLists, botId: string, from: string, to: string, at: (others: string[]) => number): BotMove | null {
  const current = lists.get(to) ?? [];
  const order = current.filter((id) => id !== botId);
  order.splice(at(order), 0, botId);
  if (from === to && order.every((id, index) => id === current[index])) return null;
  return { kind: "move", section: to, order };
}

/** What dropping `botId` there does, or null when it changes nothing. Only a row outside any department starts one. */
export function planBotDrop(lists: BotLists, botId: string, drop: BotDrop): BotMove | null {
  const from = botListOf(lists, botId);
  if (from === undefined) return null;
  if (drop.kind === "end") return lists.has(drop.list) ? placed(lists, botId, from, drop.list, (others) => others.length) : null;
  const to = botListOf(lists, drop.botId);
  if (drop.botId === botId || to === undefined) return null;
  if (drop.place === "group") return to === "" ? { kind: "group", botIds: [drop.botId, botId] } : null;
  return placed(lists, botId, from, to, (others) => others.indexOf(drop.botId) + (drop.place === "after" ? 1 : 0));
}

export function stepBot(lists: BotLists, botId: string, direction: -1 | 1): BotMove | null {
  const from = botListOf(lists, botId);
  if (from === undefined) return null;
  const ids = lists.get(from)!;
  const index = ids.indexOf(botId);
  if (index + direction < 0 || index + direction >= ids.length) return null;
  return placed(lists, botId, from, from, () => index + direction);
}

export function stepKey(event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): -1 | 1 | null {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
}

export function unusedName(base: string, taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}
