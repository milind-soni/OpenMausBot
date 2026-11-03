// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { shortcutBots, shownBotIds } from "./sidebar-shortcut-order";

const bot = (id: string) => ({ id });

function sidebar(html: string): HTMLElement {
  const root = document.createElement("aside");
  root.innerHTML = html;
  return root;
}

describe("shownBotIds", () => {
  it("reads the bot rows in the order the sidebar renders them", () => {
    const root = sidebar(`
      <div data-sidebar-section-id="section:Design"><div data-sidebar-bot-row="d"></div><div data-sidebar-bot-row="b"></div></div>
      <div data-sidebar-section-id="builtin:bots"><div data-sidebar-bot-row="a"></div></div>
    `);
    expect(shownBotIds(root)).toEqual(["d", "b", "a"]);
  });

  it("leaves out bots of a collapsed section, which renders no rows", () => {
    const root = sidebar(`
      <div data-sidebar-section-id="section:Design"></div>
      <div data-sidebar-section-id="builtin:bots"><div data-sidebar-bot-row="a"></div><div data-sidebar-bot-row="c"></div></div>
    `);
    expect(shownBotIds(root)).toEqual(["a", "c"]);
  });

  it("counts a bot shown twice, as a pinned tile and a row, at its first place", () => {
    const root = sidebar(`<div data-sidebar-bot-row="p"></div><div data-sidebar-bot-row="a"></div><div data-sidebar-bot-row="p"></div>`);
    expect(shownBotIds(root)).toEqual(["p", "a"]);
  });

  it("is empty without a sidebar", () => {
    expect(shownBotIds(null)).toEqual([]);
  });
});

describe("shortcutBots", () => {
  const bots = [bot("a"), bot("b"), bot("c"), bot("d")];

  it("orders the bots like the sidebar, so ⌘1 opens the first row on screen", () => {
    expect(shortcutBots(bots, ["d", "b", "a"]).map((b) => b.id)).toEqual(["d", "b", "a"]);
  });

  it("drops ids that are not among the bots, such as a hidden bot", () => {
    expect(shortcutBots([bot("a")], ["x", "a"]).map((b) => b.id)).toEqual(["a"]);
  });

  it("keeps the bots' own order when no sidebar is on screen", () => {
    expect(shortcutBots(bots, []).map((b) => b.id)).toEqual(["a", "b", "c", "d"]);
  });
});
