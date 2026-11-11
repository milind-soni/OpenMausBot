import { describe, expect, it } from "vitest";

import { botDropPlace, planBotDrop, stepBot, stepKey, unusedName, type BotLists } from "./sidebar-bot-drop";

const lists: BotLists = new Map([
  ["", ["atlas", "bea", "cleo"]],
  ["Work", ["dodo", "echo"]],
  ["Empty", []],
]);

describe("where a dragged bot lands", () => {
  it("starts a department from the middle half of a row that is in none, and places it above or below otherwise", () => {
    expect([0, 13, 14, 27, 40, 41, 54].map((offset) => botDropPlace(offset, 54, true))).toEqual(["before", "before", "group", "group", "group", "after", "after"]);
    expect([0, 26, 27, 54].map((offset) => botDropPlace(offset, 54, false))).toEqual(["before", "before", "after", "after"]);
  });

  it("reorders within the list, in either direction, and a drop that changes nothing does nothing", () => {
    expect(planBotDrop(lists, "cleo", { kind: "row", botId: "atlas", place: "before" })).toEqual({ kind: "move", section: "", order: ["cleo", "atlas", "bea"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "bea", place: "after" })).toEqual({ kind: "move", section: "", order: ["bea", "atlas", "cleo"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "bea", place: "before" })).toBeNull();
    expect(planBotDrop(lists, "bea", { kind: "row", botId: "bea", place: "after" })).toBeNull();
    expect(planBotDrop(lists, "cleo", { kind: "end", list: "" })).toBeNull();
  });

  it("moves a bot into a department between its rows or at its end, and back out between the others", () => {
    expect(planBotDrop(lists, "bea", { kind: "row", botId: "echo", place: "before" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "bea", "echo"] });
    expect(planBotDrop(lists, "bea", { kind: "end", list: "Work" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "echo", "bea"] });
    expect(planBotDrop(lists, "bea", { kind: "end", list: "Empty" })).toEqual({ kind: "move", section: "Empty", order: ["bea"] });
    expect(planBotDrop(lists, "echo", { kind: "row", botId: "atlas", place: "after" })).toEqual({ kind: "move", section: "", order: ["atlas", "echo", "bea", "cleo"] });
    expect(planBotDrop(lists, "echo", { kind: "end", list: "" })).toEqual({ kind: "move", section: "", order: ["atlas", "bea", "cleo", "echo"] });
  });

  it("starts a department with the bot it was dropped on first, only from a row in no department", () => {
    expect(planBotDrop(lists, "cleo", { kind: "row", botId: "atlas", place: "group" })).toEqual({ kind: "group", botIds: ["atlas", "cleo"] });
    expect(planBotDrop(lists, "dodo", { kind: "row", botId: "bea", place: "group" })).toEqual({ kind: "group", botIds: ["bea", "dodo"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "dodo", place: "group" })).toBeNull();
  });

  it("ignores a bot or a list the sidebar doesn't show as rows", () => {
    expect(planBotDrop(lists, "chief", { kind: "end", list: "Work" })).toBeNull();
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "chief", place: "before" })).toBeNull();
    expect(planBotDrop(lists, "atlas", { kind: "end", list: "Gone" })).toBeNull();
  });
});

describe("Alt+Up and Alt+Down", () => {
  it("move a bot one place within its own list and stop at either end", () => {
    expect(stepBot(lists, "bea", -1)).toEqual({ kind: "move", section: "", order: ["bea", "atlas", "cleo"] });
    expect(stepBot(lists, "bea", 1)).toEqual({ kind: "move", section: "", order: ["atlas", "cleo", "bea"] });
    expect(stepBot(lists, "dodo", 1)).toEqual({ kind: "move", section: "Work", order: ["echo", "dodo"] });
    expect(stepBot(lists, "atlas", -1)).toBeNull();
    expect(stepBot(lists, "echo", 1)).toBeNull();
    expect(stepBot(lists, "chief", 1)).toBeNull();
  });

  it("are the only keys that move it", () => {
    const key = (key: string, extra: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
      stepKey({ key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
    expect([key("ArrowUp"), key("ArrowDown"), key("ArrowLeft"), key("ArrowUp", { altKey: false }), key("ArrowDown", { shiftKey: true }), key("ArrowUp", { metaKey: true })])
      .toEqual([-1, 1, null, null, null, null]);
  });
});

describe("a new department's name", () => {
  it("is the plain name until a department has it, then the first free number", () => {
    expect(unusedName("New department", ["Work"])).toBe("New department");
    expect(unusedName("New department", ["New department", "New department 2", "New department 4"])).toBe("New department 3");
  });
});
