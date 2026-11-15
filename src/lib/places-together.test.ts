import { describe, expect, it, vi } from "vitest";

import { matchingRows, openPlaced, placedBots, placedKey, unreadByHome, type PlaceBotRow, type PlacesTogetherState } from "./places-together";

const row = (home: "computer" | "cloud", id: string, name: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home, id, threadId: `t-${id}`, name, ...over });
const on = (here: "computer" | "cloud", bots: PlaceBotRow[]): PlacesTogetherState =>
  ({ v: 1, available: true, on: true, here, other: { home: here === "cloud" ? "computer" : "cloud", state: "ready", bots } });

describe("this computer's bots and My Cloud's in one list", () => {
  it("keeps two bots with the same id apart: one key each, each with its own home", () => {
    const list = placedBots([{ id: "scout", name: "Scout here" }], on("computer", [row("cloud", "scout", "Scout there")]));
    expect(list.map((bot) => [bot.key, bot.home, bot.here, bot.name])).toEqual([
      ["computer:scout", "computer", true, "Scout here"],
      ["cloud:scout", "cloud", false, "Scout there"],
    ]);
    expect(new Set(list.map((bot) => bot.key)).size).toBe(2);
    expect(placedKey("cloud", "scout")).not.toBe(placedKey("computer", "scout"));
  });

  it("names the page's own bots by the place the page shows", () => {
    const list = placedBots([{ id: "scout", name: "Scout" }], on("cloud", [row("computer", "scout", "Scout")]));
    expect(list.map((bot) => [bot.key, bot.here])).toEqual([["cloud:scout", true], ["computer:scout", false]]);
  });

  it("opens each bot where it lives, so the same id never opens the wrong one", () => {
    const here = vi.fn(), there = vi.fn();
    const [mine, theirs] = placedBots([{ id: "scout", name: "Scout" }], on("computer", [row("cloud", "scout", "Scout")]));
    openPlaced(mine!, { here, there });
    expect([here.mock.calls, there.mock.calls]).toEqual([[["scout"]], []]);
    openPlaced(theirs!, { here, there });
    expect(there.mock.calls).toEqual([["scout"]]);
    expect(here).toHaveBeenCalledTimes(1);
  });

  it("counts unread per place: the same id unread in one place does not mark the other", () => {
    const list = placedBots([{ id: "scout", name: "Scout", tasks: [{ unread: false }] }, { id: "nova", name: "Nova", unread: true }],
      on("computer", [row("cloud", "scout", "Scout", { unread: true }), row("cloud", "nova", "Nova")]));
    expect(unreadByHome(list)).toEqual({ computer: 1, cloud: 1 });
    expect(list.filter((bot) => bot.unread).map((bot) => bot.key)).toEqual(["computer:nova", "cloud:scout"]);
  });

  it("is only this page's bots with the switch off, or before main answers", () => {
    const own = [{ id: "scout", name: "Scout" }];
    const off: PlacesTogetherState = { v: 1, available: true, on: false, here: "computer", other: null };
    expect(placedBots(own, off).map((bot) => bot.key)).toEqual(["computer:scout"]);
    expect(placedBots(own, null).map((bot) => bot.key)).toEqual(["computer:scout"]);
  });

  it("leaves out an archived bot and the pointer a move left behind", () => {
    const list = placedBots([{ id: "a", name: "Archived", hidden: true }, { id: "m", name: "Moved", hidden: true, movedTo: {} }, { id: "s", name: "Scout" }], null);
    expect(list.map((bot) => bot.id)).toEqual(["s"]);
  });

  it("finds the other place's bots by name or role as the person types", () => {
    const rows = [row("cloud", "a", "Scout", { title: "Research" }), row("cloud", "b", "Nova")];
    expect(matchingRows(rows, " ").length).toBe(2);
    expect(matchingRows(rows, "nov").map((bot) => bot.id)).toEqual(["b"]);
    expect(matchingRows(rows, "RESEARCH").map((bot) => bot.id)).toEqual(["a"]);
    expect(matchingRows(rows, "zzz")).toEqual([]);
  });
});
