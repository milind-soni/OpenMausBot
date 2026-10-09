import { describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import { buildTeamMapEdges, buildTeamMapSections, teamMapBotCount, teamMapStatus, type TeamMapSnapshot } from "./team-map";

const bots = [
  { id: "chief", name: "Atlas", section: "Work", chiefOfStaff: true, busy: true },
  { id: "maker", name: "Pixel", section: "Work" },
  { id: "home", name: "Mochi" },
  { id: "archived", name: "Old", hidden: true },
];

describe("team map projection", () => {
  it("shows persisted empty teams alongside legacy bot membership", () => {
    expect(buildTeamMapSections(bots, ["Empty", "Work"]).map(({ key, members }) => [key, members.length]))
      .toEqual([["Work", 1], ["", 1], ["Empty", 0]]);
  });
  it("groups visible bots by section and separates chiefs", () => {
    expect(buildTeamMapSections(bots)).toEqual([
      { key: "Work", name: "Work", chiefs: [bots[0]], members: [bots[1]] },
      { key: "", name: "General", chiefs: [], members: [bots[2]] },
    ]);
  });

  it("keeps the unsectioned team distinct from a section literally named General", () => {
    const projected = buildTeamMapSections([
      { id: "none", name: "Unsectioned" },
      { id: "named", name: "Named", section: " General " },
    ]);
    expect(projected.map(({ key, name }) => ({ key, name }))).toEqual([
      { key: "", name: "General" },
      { key: "General", name: "General" },
    ]);
  });

  it("keeps one edge per pair and gives live work priority", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "channel", botIds: ["chief", "maker"], lastAt: 10 }],
      queued: [{ sourceBotId: "chief", targetBotId: "maker", reason: "design" }],
      running: [{ sourceBotId: "chief", targetBotId: "maker", threadId: "task" }],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([
      { sourceBotId: "chief", targetBotId: "maker", state: "running", groupId: undefined, threadId: "task" },
    ]);
  });

  it("keeps the work thread of a queued handoff so the row can open it", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [],
      queued: [{ sourceBotId: "chief", targetBotId: "home", threadId: "home-task" }],
      running: [],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([
      { sourceBotId: "chief", targetBotId: "home", state: "queued", threadId: "home-task" },
    ]);
  });

  it("filters archived endpoints and explains live states", () => {
    const snapshot: TeamMapSnapshot = {
      collaborations: [{ groupId: "old", botIds: ["chief", "archived"], lastAt: 10 }],
      queued: [],
      running: [],
    };
    expect(buildTeamMapEdges(bots, snapshot)).toEqual([]);
    expect(teamMapStatus(bots[0])).toEqual({ label: "Working", tone: "success" });
    expect(teamMapStatus({ id: "x", name: "X", activity: "waiting-on-you" })).toEqual({
      label: "Waiting for you",
      tone: "warning",
    });
  });
});

describe("team map header", () => {
  it("counts one bot in the singular", () => {
    setLocale("en");
    expect(teamMapBotCount(1)).toBe("1 bot");
    expect(teamMapBotCount(0)).toBe("0 bots");
    expect(teamMapBotCount(2)).toBe("2 bots");
  });
});
