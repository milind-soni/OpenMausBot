import { describe, expect, it } from "vitest";

import {
  botInActiveTeam,
  firstVisibleSelection,
  groupInActiveTeam,
  isCurrentTeamActivation,
  searchHitInActiveTeam,
} from "./team-scope";

const bots = [
  { id: "atlas", teamId: "eng", chiefOfStaff: true },
  { id: "scout", teamId: "eng" },
  { id: "copy", teamId: "mkt" },
  { id: "spare" },
  { id: "ghost", teamId: "eng", hidden: true },
];

const groups = [
  { id: "standup", teamId: "eng", memberIds: ["scout"] },
  { id: "campaign", teamId: "mkt", memberIds: ["copy"] },
  { id: "dm", dm: true, memberIds: ["scout", "atlas"] },
  { id: "mixed", memberIds: ["scout", "copy"] },
];

describe("team scope", () => {
  it("All bots shows everyone except archived", () => {
    expect(bots.filter((bot) => botInActiveTeam(bot, null)).map((bot) => bot.id)).toEqual([
      "atlas",
      "scout",
      "copy",
      "spare",
    ]);
    expect(groups.filter((group) => groupInActiveTeam(group, bots, null)).map((group) => group.id)).toEqual([
      "standup",
      "campaign",
      "dm",
      "mixed",
    ]);
  });

  it("a named team is a flat roster of its bots, its rooms, and DMs wholly inside it", () => {
    expect(bots.filter((bot) => botInActiveTeam(bot, "eng")).map((bot) => bot.id)).toEqual(["atlas", "scout"]);
    expect(groups.filter((group) => groupInActiveTeam(group, bots, "eng")).map((group) => group.id)).toEqual([
      "standup",
      "dm",
    ]);
  });

  it("keeps the current chat if it still belongs, otherwise the chief then a room then a bot", () => {
    expect(firstVisibleSelection(bots, groups, "eng", "scout")).toBe("scout");
    expect(firstVisibleSelection(bots, groups, "eng", "copy")).toBe("atlas");
    expect(firstVisibleSelection(bots, groups, "mkt", "scout")).toBe("campaign");
  });

  it("a failed earlier team switch does not rewind a later one", () => {
    expect(isCurrentTeamActivation("mkt", "eng")).toBe(false);
    expect(isCurrentTeamActivation("eng", "eng")).toBe(true);
    expect(isCurrentTeamActivation(null, null)).toBe(true);
    expect(isCurrentTeamActivation("eng", null)).toBe(false);
  });

  it("drops search hits from other teams", () => {
    expect(searchHitInActiveTeam({ botId: "scout" }, bots, groups, "eng")).toBe(true);
    expect(searchHitInActiveTeam({ botId: "copy" }, bots, groups, "eng")).toBe(false);
    expect(searchHitInActiveTeam({ groupId: "standup" }, bots, groups, "eng")).toBe(true);
    expect(searchHitInActiveTeam({ groupId: "campaign" }, bots, groups, "eng")).toBe(false);
    expect(searchHitInActiveTeam({ botId: "scout" }, bots, groups, null)).toBe(true);
  });
});
