import { describe, expect, it } from "vitest";
import { fitTeams, layoutTeams, orderBots, parseBotOrders, parsePositions, reorderBot, teamSize, zoomAt, type Tile } from "./team-canvas";
import type { TeamMapSection } from "./team-map";

function section(key: string, chiefs = 0, members = 0): TeamMapSection {
  return {
    key,
    name: key || "General",
    chiefs: Array.from({ length: chiefs }, (_, index) => ({ id: `${key}-chief-${index}`, name: "Chief" })),
    members: Array.from({ length: members }, (_, index) => ({ id: `${key}-member-${index}`, name: "Member" })),
  };
}

describe("team canvas geometry", () => {
  it("sizes empty, single-column and Chief/member teams", () => {
    expect(teamSize(section("Empty"))).toEqual({ width: 276, height: 210 });
    expect(teamSize(section("Members", 0, 3))).toEqual({ width: 276, height: 494 });
    expect(teamSize(section("Chiefs", 2))).toEqual({ width: 276, height: 352 });
    expect(teamSize(section("Team", 1, 3))).toEqual({ width: 552, height: 494 });
  });

  it("uses the widest first column and tallest row while preserving saved positions", () => {
    const sections = [section("A", 0, 1), section("B", 0, 3), section("C", 1, 1), section("D")];
    const tiles = layoutTeams(sections, { C: { x: -80, y: 950 } });
    expect(tiles.map(({ key, x, y }) => ({ key, x, y }))).toEqual([
      { key: "A", x: 40, y: 40 },
      { key: "B", x: 648, y: 40 },
      { key: "C", x: -80, y: 950 },
      { key: "D", x: 648, y: 590 },
    ]);
    expect(layoutTeams([], {})).toEqual([]);
    expect(layoutTeams([section("constructor")], {})[0]).toMatchObject({ x: 40, y: 40 });
  });

  it("fits negative coordinates with padding and centers the actual bounds", () => {
    const tiles: Tile[] = [
      { key: "A", x: -100, y: -200, width: 276, height: 210 },
      { key: "B", x: 400, y: 300, width: 552, height: 352 },
    ];
    const view = fitTeams(tiles, 900, 700);
    const left = -100 * view.scale + view.x;
    const right = 952 * view.scale + view.x;
    const top = -200 * view.scale + view.y;
    const bottom = 652 * view.scale + view.y;
    expect(left).toBeCloseTo(900 - right);
    expect(top).toBeCloseTo(700 - bottom);
    expect(top).toBeCloseTo(40);
    expect(left).toBeGreaterThanOrEqual(40);
  });

  it("clamps fit scale and handles empty layouts", () => {
    const tile = { key: "A", x: 40, y: 40, width: 276, height: 210 };
    expect(fitTeams([tile], 1000, 1000).scale).toBe(1);
    expect(fitTeams([tile], 50, 50).scale).toBe(0.3);
    expect(fitTeams([], 900, 700)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it("keeps the world point under the cursor anchored while zooming", () => {
    const view = { x: -50, y: 80, scale: 0.5 };
    const point = { x: 310, y: 270 };
    const world = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
    const next = zoomAt(view, 1.4, point);
    expect(world.x * next.scale + next.x).toBeCloseTo(point.x);
    expect(world.y * next.scale + next.y).toBeCloseTo(point.y);
    expect(zoomAt(view, view.scale, point)).toEqual(view);
  });
});

describe("saved team positions", () => {
  it.each([null, "broken", "null", "[]", "42", '"text"'])("ignores invalid storage %s", (raw) => {
    expect(parsePositions(raw)).toEqual({});
  });

  it("retains valid points and drops invalid or unbounded entries", () => {
    expect(parsePositions('{"Team":{"x":-20,"y":50},"Empty":null,"Array":[2,3],"String":{"x":"3","y":2},"Missing":{"x":2},"Bound":{"x":100000,"y":0},"Negative":{"x":0,"y":-100000},"Infinity":{"x":1e999,"y":0}}'))
      .toEqual({ Team: { x: -20, y: 50 } });
  });

  it("round-trips unusual team names as own keys without prototype pollution", () => {
    const positions = parsePositions('{"__proto__":{"x":-10,"y":20},"constructor":{"x":30,"y":40},"":{"x":50,"y":60}}');
    expect(Object.getPrototypeOf(positions)).toBe(Object.prototype);
    expect(Object.hasOwn(positions, "__proto__")).toBe(true);
    expect(positions["__proto__"]).toEqual({ x: -10, y: 20 });
    expect(parsePositions(JSON.stringify(positions))).toEqual(positions);
    expect(layoutTeams([section("__proto__"), section("constructor"), section("")], positions)
      .map(({ x, y }) => ({ x, y }))).toEqual([{ x: -10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }]);
  });
});

describe("personal bot arrangement", () => {
  const bots = [{ id: "A" }, { id: "B" }, { id: "C" }];

  it("reorders only existing cards without mutating membership or source arrays", () => {
    expect(reorderBot(bots, "A", 2)).toEqual(["B", "C", "A"]);
    expect(reorderBot(bots, "C", 0)).toEqual(["C", "A", "B"]);
    expect(reorderBot(bots, "B", -10)).toEqual(["B", "A", "C"]);
    expect(reorderBot(bots, "B", 99)).toEqual(["A", "C", "B"]);
    expect(reorderBot(bots, "missing", 0)).toEqual(["A", "B", "C"]);
    expect(bots.map((bot) => bot.id)).toEqual(["A", "B", "C"]);
  });

  it("keeps new bots visible, ignores deleted IDs and applies the order separately to Chief/member lanes", () => {
    const order = ["C", "removed", "A", "chief"];
    expect(orderBots(bots, order).map((bot) => bot.id)).toEqual(["C", "A", "B"]);
    expect(orderBots([{ id: "chief" }], order)).toEqual([{ id: "chief" }]);
    expect(orderBots(bots)).toEqual(bots);
  });

  it("ignores invalid saved orders and preserves unusual section names safely", () => {
    for (const raw of [null, "broken", "null", "[]", "42"]) expect(parseBotOrders(raw)).toEqual({});
    const orders = parseBotOrders('{"Team":["B","B",null,4,"","A"],"bad":{},"__proto__":["C"],"constructor":["A"],"":["B"]}');
    expect(orders.Team).toEqual(["B", "A"]);
    expect(Object.hasOwn(orders, "bad")).toBe(false);
    expect(Object.getPrototypeOf(orders)).toBe(Object.prototype);
    expect(Object.hasOwn(orders, "__proto__")).toBe(true);
    expect(orders["__proto__"]).toEqual(["C"]);
    expect(parseBotOrders(JSON.stringify(orders))).toEqual(orders);
  });
});
