import { CARD_HEIGHT, CARD_WIDTH, GAP, HEADER_HEIGHT, TEAM_PADDING, orderBots, type Point, type Tile } from "./team-canvas";
import type { TeamGeometry } from "./team-canvas-computers";
import type { TeamMapEdge, TeamMapSection } from "./team-map";

export interface CardBox extends Point { width: number; height: number }

export interface HandoffLine {
  key: string;
  state: TeamMapEdge["state"];
  path: string;
  /** A filled arrow at the receiving bot, for running and queued hand-offs. */
  arrow?: string;
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

const DETOUR = 48;
const ARROW_LENGTH = 9, ARROW_HALF_WIDTH = 4.5;

interface Curve { start: Point; first: Point; second: Point; end: Point }

const curvePoint = ({ start, first, second, end }: Curve, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * u * start.x + 3 * u * u * t * first.x + 3 * u * t * t * second.x + t * t * t * end.x,
    y: u * u * u * start.y + 3 * u * u * t * first.y + 3 * u * t * t * second.y + t * t * t * end.y,
  };
};

const inside = (point: Point, box: CardBox) => point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

/** Whether the curve runs through the inside of any of these cards. */
const crossesCards = (curve: Curve, cards: CardBox[]) => cards.some((box) => {
  for (let step = 1; step < 20; step++) if (inside(curvePoint(curve, step / 20), box)) return true;
  return false;
});

/** Edge to facing edge, bending half-way between the two cards. */
function directCurve(from: CardBox, to: CardBox): Curve {
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
  return { start, first, second, end };
}

/** Out of one side of both cards and back in, clear of every card in between. */
function detours(from: CardBox, to: CardBox, blocking: CardBox[]): Curve[] {
  const all = [from, to, ...blocking];
  const right = Math.max(...all.map((box) => box.x + box.width)) + DETOUR, left = Math.min(...all.map((box) => box.x)) - DETOUR;
  const bottom = Math.max(...all.map((box) => box.y + box.height)) + DETOUR, top = Math.min(...all.map((box) => box.y)) - DETOUR;
  const middleY = (box: CardBox) => box.y + box.height / 2, middleX = (box: CardBox) => box.x + box.width / 2;
  const sideways = (edge: (box: CardBox) => number, out: number): Curve => ({
    start: { x: edge(from), y: middleY(from) }, first: { x: out, y: middleY(from) },
    second: { x: out, y: middleY(to) }, end: { x: edge(to), y: middleY(to) },
  });
  const upDown = (edge: (box: CardBox) => number, out: number): Curve => ({
    start: { x: middleX(from), y: edge(from) }, first: { x: middleX(from), y: out },
    second: { x: middleX(to), y: out }, end: { x: middleX(to), y: edge(to) },
  });
  return [
    sideways((box) => box.x + box.width, right), sideways((box) => box.x, left),
    upDown((box) => box.y + box.height, bottom), upDown((box) => box.y, top),
  ];
}

/** A small filled triangle at the receiving end, pointing the way the work goes. */
function arrowHead({ second, end, start }: Curve): string {
  const from = second.x === end.x && second.y === end.y ? start : second;
  const length = Math.hypot(end.x - from.x, end.y - from.y) || 1;
  const dx = (end.x - from.x) / length, dy = (end.y - from.y) / length;
  const baseX = end.x - dx * ARROW_LENGTH, baseY = end.y - dy * ARROW_LENGTH;
  const round = (value: number) => Math.round(value * 100) / 100;
  return `M ${round(end.x)} ${round(end.y)} L ${round(baseX - dy * ARROW_HALF_WIDTH)} ${round(baseY + dx * ARROW_HALF_WIDTH)} L ${round(baseX + dy * ARROW_HALF_WIDTH)} ${round(baseY - dx * ARROW_HALF_WIDTH)} Z`;
}

/**
 * A curved line from the bot handing work on to the bot receiving it, edge to facing edge.
 * When that curve would run through another bot's card it goes around the cards instead,
 * on a way round that enters no card, its own two included.
 * Running and queued hand-offs end in an arrow at the receiving bot; a plain connection has none.
 */
export function handoffLines(edges: TeamMapEdge[], boxes: Map<string, CardBox>): HandoffLine[] {
  return edges.flatMap((edge) => {
    const from = boxes.get(edge.sourceBotId), to = boxes.get(edge.targetBotId);
    if (!from || !to || edge.sourceBotId === edge.targetBotId) return [];
    const others = [...boxes].filter(([id]) => id !== edge.sourceBotId && id !== edge.targetBotId).map(([, box]) => box);
    const direct = directCurve(from, to);
    const blocking = others.filter((box) => crossesCards(direct, [box]));
    const curve = blocking.length ? detours(from, to, blocking).find((route) => !crossesCards(route, [from, to, ...others])) ?? direct : direct;
    const { start, first, second, end } = curve;
    return [{
      key: `${edge.sourceBotId}:${edge.targetBotId}`,
      state: edge.state,
      path: `M ${start.x} ${start.y} C ${first.x} ${first.y} ${second.x} ${second.y} ${end.x} ${end.y}`,
      ...(edge.state === "connected" ? {} : { arrow: arrowHead(curve) }),
      label: curvePoint(curve, 0.5),
    }];
  });
}
