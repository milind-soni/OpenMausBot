import { describe, expect, it } from "vitest";

import { matchingRows, placedKey, type PlaceBotRow } from "./places-together";

const row = (home: "computer" | "cloud", id: string, name: string, over: Partial<PlaceBotRow> = {}): PlaceBotRow => ({ home, id, threadId: `t-${id}`, name, ...over });

describe("the other place's bots beside this page's own", () => {
  it("keys a bot by its home and its id, so the same id in two places is two keys", () => {
    expect(placedKey("cloud", "scout")).toBe("cloud:scout");
    expect(placedKey("cloud", "scout")).not.toBe(placedKey("computer", "scout"));
  });

  it("finds the other place's bots by name or role as the person types", () => {
    const rows = [row("cloud", "a", "Scout", { title: "Research" }), row("cloud", "b", "Nova")];
    expect(matchingRows(rows, " ").length).toBe(2);
    expect(matchingRows(rows, "nov").map((bot) => bot.id)).toEqual(["b"]);
    expect(matchingRows(rows, "RESEARCH").map((bot) => bot.id)).toEqual(["a"]);
    expect(matchingRows(rows, "zzz")).toEqual([]);
  });
});
