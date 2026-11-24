import { describe, expect, it } from "vitest";
import { botCardBoxes, handoffLines, type CardBox } from "./team-canvas-handoffs";
import { layoutTeams, teamSize } from "./team-canvas";
import type { TeamMapSection } from "./team-map";

const bot = (id: string, chiefOfStaff = false) => ({ id, name: id, chiefOfStaff });
const sales: TeamMapSection = { key: "Sales", name: "Sales", chiefs: [bot("chief", true)], members: [bot("ana"), bot("ben")] };
const ops: TeamMapSection = { key: "Ops", name: "Ops", chiefs: [], members: [bot("cy")] };

describe("botCardBoxes", () => {
  it("places chiefs left of members, each column centred under the team header", () => {
    const tiles = [{ key: "Sales", x: 100, y: 50, ...teamSize(sales) }];
    const boxes = botCardBoxes([sales], tiles, [null], {});
    expect(boxes.get("chief")).toEqual({ x: 120, y: 50 + 64 + 71, width: 236, height: 126 });
    expect(boxes.get("ana")).toEqual({ x: 396, y: 114, width: 236, height: 126 });
    expect(boxes.get("ben")).toEqual({ x: 396, y: 256, width: 236, height: 126 });
  });

  it("follows the person's own card order and a team with members only", () => {
    const tiles = layoutTeams([sales, ops], {});
    const boxes = botCardBoxes([sales, ops], tiles, [null, null], { Sales: ["ben", "ana"] });
    expect(boxes.get("ben")!.y).toBeLessThan(boxes.get("ana")!.y);
    expect(boxes.get("cy")).toMatchObject({ x: tiles[1].x + 20, y: tiles[1].y + 64 });
  });

  it("uses the computer layout's own card spots when a team draws computers", () => {
    const tiles = [{ key: "Ops", x: 10, y: 20, width: 400, height: 300 }];
    const geometry = { width: 400, height: 300, cards: [{ botId: "cy", x: 30, y: 90 }], monitors: [], links: [], tree: [] };
    expect(botCardBoxes([ops], tiles, [geometry], {})).toEqual(new Map([["cy", { x: 40, y: 110, width: 236, height: 126 }]]));
  });
});

describe("handoffLines", () => {
  const box = (x: number, y: number): CardBox => ({ x, y, width: 100, height: 50 });
  const boxes = new Map([["a", box(0, 0)], ["b", box(300, 100)], ["c", box(0, 200)]]);

  it("joins side-by-side cards from the giver's facing edge to the receiver's, labelled mid-way", () => {
    expect(handoffLines([{ sourceBotId: "a", targetBotId: "b", state: "running" }], boxes)).toEqual([{
      key: "a:b", state: "running", path: "M 100 25 C 200 25 200 125 300 125", arrow: "M 300 125 L 291 129.5 L 291 120.5 Z", label: { x: 200, y: 75 },
    }]);
    const back = handoffLines([{ sourceBotId: "b", targetBotId: "a", state: "queued" }], boxes)[0];
    expect(back.path).toBe("M 300 125 C 200 125 200 25 100 25");
    expect(back.arrow).toBe("M 100 25 L 109 20.5 L 109 29.5 Z");
  });

  it("goes around a card standing between the two bots, label and all", () => {
    const stack = new Map([["a", box(0, 0)], ["b", box(0, 100)], ["c", box(0, 200)]]);
    const [line] = handoffLines([{ sourceBotId: "a", targetBotId: "c", state: "running" }], stack);
    expect(line.path).toBe("M 100 25 C 148 25 148 225 100 225");
    expect(line.arrow).toBe("M 100 225 L 109 220.5 L 109 229.5 Z");
    expect(line.label).toEqual({ x: 136, y: 125 });
    expect(line.label.x).toBeGreaterThan(stack.get("b")!.x + stack.get("b")!.width);
    expect(handoffLines([{ sourceBotId: "a", targetBotId: "b", state: "running" }], stack)[0].path).toBe("M 50 50 C 50 75 50 75 50 100");
  });

  it("never routes the way around through the giver's or receiver's own card", () => {
    const wide = (x: number, y: number): CardBox => ({ x, y, width: 236, height: 126 });
    const cards = new Map([["from", wide(0, 0)], ["to", wide(500, 80)], ["between", wide(260, 90)]]);
    const [line] = handoffLines([{ sourceBotId: "from", targetBotId: "to", state: "running" }], cards);
    const steps = line.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    const [sx, sy, ax, ay, bx, by, ex, ey] = steps;
    for (let step = 1; step < 20; step++) {
      const t = step / 20, u = 1 - t;
      const x = u * u * u * sx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * ex;
      const y = u * u * u * sy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * ey;
      for (const card of cards.values()) {
        expect(x > card.x && x < card.x + card.width && y > card.y && y < card.y + card.height).toBe(false);
      }
    }
  });

  it("joins stacked cards bottom to top, and skips bots that are not on the canvas", () => {
    const lines = handoffLines([
      { sourceBotId: "c", targetBotId: "a", state: "connected" },
      { sourceBotId: "a", targetBotId: "hidden", state: "running" },
    ], boxes);
    expect(lines).toEqual([{ key: "c:a", state: "connected", path: "M 50 200 C 50 125 50 125 50 50", label: { x: 50, y: 125 } }]);
  });
});
