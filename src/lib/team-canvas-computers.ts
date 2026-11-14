import { CARD_HEIGHT, CARD_WIDTH, GAP, HEADER_HEIGHT, TEAM_PADDING, type Point } from "./team-canvas";

export const MONITOR_WIDTH = 272;
export const MONITOR_HEIGHT = 208;
export const LINK_WIDTH = 44;
export const TREE_INDENT = 28;

/** What one team draws: the computers its own bots use, and the team's shared computer with the bots on Auto. */
export interface TeamComputers {
  own: ReadonlyMap<string, string>;
  team?: { id: string; botIds: readonly string[] };
}

export interface TeamGeometry {
  width: number;
  height: number;
  cards: Array<Point & { botId: string }>;
  monitors: Array<Point & { id: string }>;
  /** Polylines in the team's own coordinates, from a bot card's right edge to its computer's left edge. */
  links: Array<{ botId: string; computerId: string; points: Point[] }>;
  /** The chief's line down the left side to each member card, when the team has both. */
  tree: Point[][];
}

/**
 * With computers shown, a team is one column of rows, chiefs first, each bot's own computer beside its card and the
 * shared computer to the right of them all. Null when the team has no computer to draw: it keeps its usual layout.
 */
export function teamGeometry(section: { chiefs: ReadonlyArray<{ id: string }>; members: ReadonlyArray<{ id: string }> }, computers: TeamComputers): TeamGeometry | null {
  const bots = [...section.chiefs, ...section.members];
  const own = bots.filter((bot) => computers.own.has(bot.id));
  if (!own.length && !computers.team) return null;
  const tree = section.chiefs.length > 0 && section.members.length > 0;
  const rowHeight = own.length ? MONITOR_HEIGHT : CARD_HEIGHT;
  const rowTop = (index: number) => HEADER_HEIGHT + index * (rowHeight + GAP);
  const rowCenter = (index: number) => rowTop(index) + rowHeight / 2;
  const cardsRight = TEAM_PADDING + (tree ? TREE_INDENT : 0) + CARD_WIDTH;
  const monitorX = cardsRight + LINK_WIDTH;
  const cards = bots.map((bot, index) => ({
    botId: bot.id,
    x: TEAM_PADDING + (tree && index >= section.chiefs.length ? TREE_INDENT : 0),
    y: rowTop(index) + (rowHeight - CARD_HEIGHT) / 2,
  }));
  const monitors: TeamGeometry["monitors"] = [];
  const links: TeamGeometry["links"] = [];
  bots.forEach((bot, index) => {
    const id = computers.own.get(bot.id);
    if (!id) return;
    monitors.push({ id, x: monitorX, y: rowTop(index) + (rowHeight - MONITOR_HEIGHT) / 2 });
    links.push({ botId: bot.id, computerId: id, points: [{ x: cards[index].x + CARD_WIDTH, y: rowCenter(index) }, { x: monitorX, y: rowCenter(index) }] });
  });
  const rowsBottom = rowTop(bots.length) - GAP;
  let bottom = Math.max(rowsBottom, HEADER_HEIGHT + CARD_HEIGHT);
  let right = own.length ? monitorX + MONITOR_WIDTH : cardsRight;
  if (computers.team) {
    const users = bots.map((bot, index) => ({ bot, index })).filter(({ bot }) => computers.team!.botIds.includes(bot.id));
    const centers = (users.length ? users : bots.map((bot, index) => ({ bot, index }))).map(({ index }) => rowCenter(index));
    const middle = centers.length ? (Math.min(...centers) + Math.max(...centers)) / 2 : HEADER_HEIGHT + MONITOR_HEIGHT / 2;
    const x = right + LINK_WIDTH * (own.length ? 1.5 : 2);
    const y = Math.max(HEADER_HEIGHT, middle - MONITOR_HEIGHT / 2);
    const busX = x - LINK_WIDTH / 2;
    const port = y + MONITOR_HEIGHT / 2;
    monitors.push({ id: computers.team.id, x, y });
    for (const { bot, index } of users) {
      const start = { x: cards[index].x + CARD_WIDTH, y: rowCenter(index) };
      links.push({ botId: bot.id, computerId: computers.team.id, points: [start, { x: busX, y: start.y }, { x: busX, y: port }, { x, y: port }] });
    }
    right = x + MONITOR_WIDTH;
    bottom = Math.max(bottom, y + MONITOR_HEIGHT);
  }
  const treeLines: Point[][] = [];
  if (tree) {
    const spine = TEAM_PADDING + TREE_INDENT / 2;
    const firstMember = section.chiefs.length;
    treeLines.push([{ x: spine, y: cards[firstMember - 1].y + CARD_HEIGHT }, { x: spine, y: rowCenter(bots.length - 1) }]);
    for (let index = firstMember; index < bots.length; index++) treeLines.push([{ x: spine, y: rowCenter(index) }, { x: cards[index].x, y: rowCenter(index) }]);
  }
  return { width: right + TEAM_PADDING, height: bottom + TEAM_PADDING, cards, monitors, links, tree: treeLines };
}

/** The column count whose grid of teams fits the viewport at the largest scale. */
export function bestColumns(sizes: ReadonlyArray<{ width: number; height: number }>, viewport: { width: number; height: number }, gap = 56): number {
  if (sizes.length < 2 || viewport.width <= 0 || viewport.height <= 0) return 2;
  let best = { columns: 2, scale: 0 };
  for (let columns = 1; columns <= Math.min(sizes.length, 6); columns++) {
    const widths = Array.from({ length: columns }, (_, column) => Math.max(0, ...sizes.filter((_, index) => index % columns === column).map((size) => size.width)));
    const rows = Math.ceil(sizes.length / columns);
    const heights = Array.from({ length: rows }, (_, row) => Math.max(0, ...sizes.slice(row * columns, row * columns + columns).map((size) => size.height)));
    const width = widths.reduce((sum, value) => sum + value, 0) + gap * (columns - 1);
    const height = heights.reduce((sum, value) => sum + value, 0) + gap * (rows - 1);
    const scale = Math.min((viewport.width - 80) / width, (viewport.height - 80) / height);
    if (scale > best.scale + 0.01) best = { columns, scale };
  }
  return best.columns;
}

export function polylinePath(points: readonly Point[]): string {
  return points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ");
}
