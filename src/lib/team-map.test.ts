import { describe, expect, it } from "vitest";

import { setLocale } from "./i18n";
import {
  buildTeamMapEdges,
  buildTeamMapSections,
  formatSessionElapsed,
  groupSessionsByBot,
  sortSessionsForDisplay,
  teamMapBotCount,
  teamMapSessionCounts,
  teamMapSessionStatus,
  teamMapStatus,
  type TeamMapSnapshot,
} from "./team-map";
import type { TeamMapSession } from "../../shared/team-map-sessions";

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
    setLocale("pt-br");
    expect(buildTeamMapSections([{ id: "none", name: "Unsectioned" }])[0]!.name, "the fallback in the app language").toBe("Geral");
    setLocale("en");
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

describe("team map live sessions", () => {
  const sessions: TeamMapSession[] = [
    { botId: "chief", threadId: "a", title: "Design review", state: "running", startedAt: 0 },
    { botId: "chief", threadId: "b", title: "Stuck task", state: "stuck", startedAt: 100 },
    { botId: "maker", threadId: "c", title: "Queued task", state: "queued", startedAt: 50 },
  ];

  it("groups sessions by bot", () => {
    expect([...groupSessionsByBot(sessions).entries()].map(([botId, items]) => [botId, items.length]))
      .toEqual([["chief", 2], ["maker", 1]]);
  });

  it("counts sessions per state", () => {
    expect(teamMapSessionCounts(sessions)).toEqual({ running: 1, stuck: 1, queued: 1, waiting: 0 });
  });

  it("puts sessions needing attention first, newest first within a state", () => {
    const tied = [
      { ...sessions[0]!, threadId: "older", startedAt: 0 },
      { ...sessions[0]!, threadId: "newer", startedAt: 10 },
    ];
    expect(sortSessionsForDisplay([sessions[2]!, sessions[0]!, sessions[1]!]).map((session) => session.state))
      .toEqual(["stuck", "running", "queued"]);
    expect(sortSessionsForDisplay(tied).map((session) => session.threadId)).toEqual(["newer", "older"]);
  });

  it("labels each session state, with status never conveyed by color alone", () => {
    expect(teamMapSessionStatus("running")).toEqual({ label: "Working", tone: "success" });
    expect(teamMapSessionStatus("stuck")).toEqual({ label: "Stuck", tone: "danger" });
    expect(teamMapSessionStatus("waiting")).toEqual({ label: "Waiting", tone: "warning" });
    expect(teamMapSessionStatus("queued")).toEqual({ label: "Queued", tone: "idle" });
  });

  it("formats elapsed time plainly, rolling over to hours", () => {
    const startedAt = 1_000_000;
    expect(formatSessionElapsed(startedAt, startedAt)).toBe("0 min");
    expect(formatSessionElapsed(startedAt, startedAt + 9 * 60_000)).toBe("9 min");
    expect(formatSessionElapsed(startedAt, startedAt + 125 * 60_000)).toBe("2 h");
  });
});
