import { describe, expect, it } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, HEADER_HEIGHT, TEAM_PADDING, layoutTeams, teamSize } from "./team-canvas";
import { LINK_WIDTH, MONITOR_HEIGHT, MONITOR_WIDTH, TREE_INDENT, bestColumns, polylinePath, teamGeometry } from "./team-canvas-computers";
import { computerForBot, haveParam, localFrameTime, teamComputersFor } from "./map-computers";
import type { MapComputer } from "../../shared/map-computer";
import type { TeamMapSection } from "./team-map";

const bots = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}`, name: `${prefix}${index}` }));
const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("computers on the team canvas", () => {
  it("keeps the usual layout for a team with nothing to draw", () => {
    expect(teamGeometry({ chiefs: bots("c", 1), members: bots("m", 3) }, { own: new Map() })).toBeNull();
  });

  it("puts each bot's own computer beside its card, joined by a straight line, chiefs first", () => {
    const geometry = teamGeometry({ chiefs: bots("c", 1), members: bots("m", 3) },
      { own: new Map([["c0", "c0"], ["m0", "m0"], ["m1", "m1"], ["m2", "m2"]]) })!;
    expect(geometry.cards.map((card) => card.botId)).toEqual(["c0", "m0", "m1", "m2"]);
    expect(geometry.cards[0].x).toBe(TEAM_PADDING);
    expect(geometry.cards[1].x).toBe(TEAM_PADDING + TREE_INDENT);
    for (const [index, monitor] of geometry.monitors.entries()) {
      const card = geometry.cards[index];
      expect(monitor.id).toBe(card.botId);
      expect(monitor.x).toBe(TEAM_PADDING + TREE_INDENT + CARD_WIDTH + LINK_WIDTH);
      expect(card.y + CARD_HEIGHT / 2).toBe(monitor.y + MONITOR_HEIGHT / 2);
      expect(geometry.links[index].points).toEqual([
        { x: card.x + CARD_WIDTH, y: card.y + CARD_HEIGHT / 2 },
        { x: monitor.x, y: card.y + CARD_HEIGHT / 2 },
      ]);
    }
    const boxes = [
      ...geometry.cards.map((card) => ({ ...card, width: CARD_WIDTH, height: CARD_HEIGHT })),
      ...geometry.monitors.map((monitor) => ({ ...monitor, width: MONITOR_WIDTH, height: MONITOR_HEIGHT })),
    ];
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(overlaps(box, other)).toBe(false)));
    for (const box of boxes) {
      expect(box.y).toBeGreaterThanOrEqual(HEADER_HEIGHT);
      expect(box.x + box.width).toBeLessThanOrEqual(geometry.width - TEAM_PADDING);
      expect(box.y + box.height).toBeLessThanOrEqual(geometry.height - TEAM_PADDING);
    }
    expect(geometry.tree).toHaveLength(4);
  });

  it("joins a team's shared computer to every bot of the team that uses it", () => {
    const geometry = teamGeometry({ chiefs: bots("c", 1), members: bots("m", 3) },
      { own: new Map([["c0", "c0"]]), team: { id: "computer_t", botIds: ["m0", "m1", "m2"] } })!;
    const shared = geometry.monitors.find((monitor) => monitor.id === "computer_t")!;
    const ownRight = geometry.monitors.find((monitor) => monitor.id === "c0")!.x + MONITOR_WIDTH;
    expect(shared.x).toBeGreaterThan(ownRight);
    const links = geometry.links.filter((link) => link.computerId === "computer_t");
    expect(links.map((link) => link.botId)).toEqual(["m0", "m1", "m2"]);
    for (const link of links) {
      expect(link.points.at(-1)).toEqual({ x: shared.x, y: shared.y + MONITOR_HEIGHT / 2 });
      expect(link.points[0].x).toBe(TEAM_PADDING + TREE_INDENT + CARD_WIDTH);
    }
    expect(geometry.width).toBe(shared.x + MONITOR_WIDTH + TEAM_PADDING);
  });

  it("gives a team with only a shared computer card-height rows and room for the monitor", () => {
    const geometry = teamGeometry({ chiefs: [], members: bots("m", 1) }, { own: new Map(), team: { id: "computer_t", botIds: ["m0"] } })!;
    expect(geometry.cards[0].y).toBe(HEADER_HEIGHT);
    expect(geometry.height).toBeGreaterThanOrEqual(HEADER_HEIGHT + MONITOR_HEIGHT + TEAM_PADDING);
    expect(geometry.tree).toEqual([]);
  });

  it("lays teams out in the column count that fits the window best, two by default", () => {
    const wide = { width: 1200, height: 900 };
    expect(bestColumns([wide, wide, wide, wide], { width: 1600, height: 900 })).toBe(2);
    const tall = { width: 600, height: 1200 };
    expect(bestColumns([tall, tall, tall, tall], { width: 1600, height: 900 })).toBe(4);
    const sections: TeamMapSection[] = ["A", "B", "C"].map((key) => ({ key, name: key, chiefs: [], members: bots(key, 1) }));
    const tiles = layoutTeams(sections, {}, { sizes: [tall, tall, tall], columns: 3 });
    expect(tiles.map((tile) => [tile.x, tile.y])).toEqual([[40, 40], [40 + 600 + 56, 40], [40 + 2 * (600 + 56), 40]]);
    expect(layoutTeams(sections, {})).toEqual(layoutTeams(sections, {}, { sizes: sections.map(teamSize), columns: 2 }));
  });

  it("draws polylines as SVG paths", () => {
    expect(polylinePath([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 2 }])).toBe("M1 2 L3 4 L5 2");
  });
});

describe("map computers in the renderer", () => {
  const computers: MapComputer[] = [
    { id: "ada", kind: "bot", name: "Ada", botIds: ["ada"], state: "working" },
    { id: "computer_t", kind: "team", name: "Shared", section: "Ops", botIds: ["ben", "cy"], state: "idle" },
  ];

  it("sends a bot's live frames to its own computer, else to the shared one it uses", () => {
    expect(computerForBot(computers, "ada")?.id).toBe("ada");
    expect(computerForBot(computers, "cy")?.id).toBe("computer_t");
    expect(computerForBot(computers, "zed")).toBeUndefined();
  });

  it("picks the computers a team draws", () => {
    const team = teamComputersFor("Ops", ["ben", "cy", "ada"], computers);
    expect([...team.own]).toEqual([["ada", "ada"]]);
    expect(team.team).toEqual({ id: "computer_t", botIds: ["ben", "cy"] });
    expect(teamComputersFor("Research", ["zed"], computers)).toEqual({ own: new Map() });
  });

  it("names the frames it holds and dates server frames on this clock", () => {
    expect(haveParam({ ada: { url: "blob:a", at: 1, version: "map-1" }, computer_t: { url: "blob:b", at: 2, version: "live" } }))
      .toBe("ada:map-1,computer_t:live");
    expect(localFrameTime(9_000, 10_000, 50_000)).toBe(49_000);
    expect(localFrameTime(11_000, 10_000, 50_000)).toBe(50_000);
  });
});
