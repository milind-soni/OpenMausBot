import { CARD_HEIGHT, CARD_WIDTH, GAP, HEADER_HEIGHT, TEAM_PADDING, orderBots, type Point, type Tile } from "./team-canvas";
import type { TeamGeometry } from "./team-canvas-computers";
import type { TeamMapEdge, TeamMapSection } from "./team-map";

export interface CardBox extends Point { width: number; height: number }

export interface HandoffLine {
  key: string;
  state: TeamMapEdge["state"];
  path: string;
  /** Where the line's label sits: the middle of the curve. */
  label: Point;
}

/** Spacer between the chiefs column and the members column when a team draws no computers. */
const CHIEF_GAP = 40;

/** Where each bot's card sits on the canvas, in world coordinates, for both team layouts. */
export function botCardBoxes(
  sections: TeamMapSection[],
  tiles: Tile[],
  geometries: Array<TeamGeometry | null>,
  orders: Record<string, string[]>,
): Map<string, CardBox> {
  const boxes = new Map<string, CardBox>();
  const place = (botId: string, x: number, y: number) => boxes.set(botId, { x, y, width: CARD_WIDTH, height: CARD_HEIGHT });
  sections.forEach((section, index) => {
    const tile = tiles[index], geometry = geometries[index];
    if (!tile) return;
    if (geometry) {
      for (const card of geometry.cards) place(card.botId, tile.x + card.x, tile.y + card.y);
      return;
    }
    const content = tile.height - HEADER_HEIGHT - TEAM_PADDING;
    const columns = [section.chiefs, section.members].filter((column) => column.length > 0);
    columns.forEach((column, columnIndex) => {
      const height = column.length * (CARD_HEIGHT + GAP) - GAP;
      const top = tile.y + HEADER_HEIGHT + (content - height) / 2;
      const left = tile.x + TEAM_PADDING + columnIndex * (CARD_WIDTH + CHIEF_GAP);
      orderBots(column, Object.hasOwn(orders, section.key) ? orders[section.key] : []).forEach((bot, row) => place(bot.id, left, top + row * (CARD_HEIGHT + GAP)));
    });
  });
  return boxes;
}

/** A curved line from the bot handing work on to the bot receiving it, edge to facing edge. */
export function handoffLines(edges: TeamMapEdge[], boxes: Map<string, CardBox>): HandoffLine[] {
  return edges.flatMap((edge) => {
    const from = boxes.get(edge.sourceBotId), to = boxes.get(edge.targetBotId);
    if (!from || !to || edge.sourceBotId === edge.targetBotId) return [];
    const sideBySide = from.x + from.width <= to.x || to.x + to.width <= from.x;
    const forward = sideBySide ? from.x < to.x : from.y < to.y;
    const anchor = (box: CardBox, leaving: boolean): Point => {
      const far = leaving === forward;
      return sideBySide
        ? { x: far ? box.x + box.width : box.x, y: box.y + box.height / 2 }
        : { x: box.x + box.width / 2, y: far ? box.y + box.height : box.y };
    };
    const start = anchor(from, true), end = anchor(to, false);
    const bend = sideBySide ? (end.x - start.x) / 2 : (end.y - start.y) / 2;
    const first = sideBySide ? { x: start.x + bend, y: start.y } : { x: start.x, y: start.y + bend };
    const second = sideBySide ? { x: end.x - bend, y: end.y } : { x: end.x, y: end.y - bend };
    return [{
      key: `${edge.sourceBotId}:${edge.targetBotId}`,
      state: edge.state,
      path: `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`,
      label: { x: (start.x + 3 * first.x + 3 * second.x + end.x) / 8, y: (start.y + 3 * first.y + 3 * second.y + end.y) / 8 },
    }];
  });
}
