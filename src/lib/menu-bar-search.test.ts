import { describe, expect, it } from "vitest";

import { menuBarBotMatches } from "./menu-bar-search";

describe("menuBarBotMatches", () => {
  const bot = { name: "Chief Grokkie", title: "Chief of Staff" };

  it("keeps every bot when the query is empty", () => {
    expect(menuBarBotMatches(bot, "", "Working…")).toBe(true);
    expect(menuBarBotMatches(bot, "   ", "Working…")).toBe(true);
  });

  it("matches name, title, or preview case-insensitively", () => {
    expect(menuBarBotMatches(bot, "chief", "Online")).toBe(true);
    expect(menuBarBotMatches(bot, "STAFF", "Online")).toBe(true);
    expect(menuBarBotMatches(bot, "working", "Working on PR 630")).toBe(true);
  });

  it("rejects bots that miss the needle", () => {
    expect(menuBarBotMatches(bot, "ledger", "Online")).toBe(false);
  });
});
