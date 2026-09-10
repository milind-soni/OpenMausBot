import { describe, expect, it } from "vitest";

import { setLocale } from "./i18n";

import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveRowWithinList,
  moveSection,
  orderedSidebarRows,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sidebarLayoutInteractive,
  sidebarStamp,
  sidebarGoalRunPreview,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  userSectionId,
  userSectionName,
} from "./sidebar-layout";

describe("sidebar virtual sections", () => {
  it("keeps reserved labels separate from identically named user sections", () => {
    for (const name of ["Pinned", "pinned", "channels", "bots", "bot-chats", "Bot Chats"]) {
      const id = userSectionId(name);
      expect([PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID]).not.toContain(id);
      expect(userSectionName(id)).toBe(name);
      expect(sidebarSectionLabel(id)).toBe(name);
    }
    expect(sidebarSectionLabel(CHANNELS_SECTION_ID)).toBe("Groups");
    expect(sidebarSectionLabel(BOT_CHATS_SECTION_ID)).toBe("Bot threads");
  });

  it("round-trips every valid section name without URI encoding", () => {
    const maxLengthEmojiName = "🧠".repeat(30);
    expect(maxLengthEmojiName).toHaveLength(60);

    for (const name of ["Design / Research", "100%", "\ud800", maxLengthEmojiName]) {
      const id = userSectionId(name);
      expect(id).toBe(`section:${name}`);
      expect(userSectionName(id)).toBe(name);
      expect(sidebarSectionLabel(id)).toBe(name);
    }
  });

  it("shows pinned bots once without erasing their saved context", () => {
    const bot = { id: "writer", section: "Work", pinned: true };
    const parts = partitionSidebarBots([
      { id: "chief", chiefOfStaff: true },
      bot,
      { id: "plain" },
      { id: "hidden", hidden: true, pinned: true },
    ]);
    expect(parts.unsectionedChief?.id).toBe("chief");
    expect(parts.pinnedBots).toEqual([bot]);
    expect(parts.sectionedBots).toEqual([]);
    expect(parts.unsectionedBots.map((candidate) => candidate.id)).toEqual(["plain"]);
    expect(bot.section).toBe("Work");
  });

  it("shows DMs in Bot Chats without rewriting their comms context", () => {
    const dm = { id: "dm", dm: true, section: "Work" };
    const namedBotChats = { id: "named", section: "Bot Chats" };
    const parts = partitionSidebarGroups([
      dm,
      { id: "project", section: "Work" },
      namedBotChats,
      { id: "general" },
    ]);
    expect(parts.botChats).toEqual([dm]);
    expect(parts.sectionedRooms.map((room) => room.id)).toEqual(["project", "named"]);
    expect(parts.unsectionedRooms.map((room) => room.id)).toEqual(["general"]);
    expect(dm.section).toBe("Work");
    expect(namedBotChats.section).toBe("Bot Chats");
  });

  it("keeps section Chiefs in their actual section", () => {
    const chief = { id: "chief", chiefOfStaff: true, section: "Work", pinned: true };
    const parts = partitionSidebarBots([chief]);
    expect(parts.sectionChiefs).toEqual([chief]);
    expect(parts.pinnedBots).toEqual([]);
  });

  it("forces filtered and icon-only views open and non-reorderable", () => {
    expect(sidebarLayoutInteractive("comfortable", "")).toBe(true);
    expect(sidebarLayoutInteractive("comfortable", "writer")).toBe(false);
    expect(sidebarLayoutInteractive("icons", "")).toBe(false);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "compact", "")).toBe(true);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "compact", "writer")).toBe(false);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "icons", "")).toBe(false);
  });

  it("keeps a terminal channel goal meaningful in the sidebar", () => {
    expect(sidebarGoalRunPreview({
      runId: "run-1",
      goal: "Ship the launch post",
      status: "completed",
      coordinatorBotId: "lead",
      coordinatorName: "Lead",
      turnCount: 3,
      maxTurns: 13,
      detail: "Drafted and verified.",
      startedAt: 1,
      finishedAt: 2,
    })).toBe("Completed: Drafted and verified.");
  });
});

describe("sidebar section ordering", () => {
  const natural = [
    PINNED_SECTION_ID,
    CHANNELS_SECTION_ID,
    BOT_CHATS_SECTION_ID,
    BOTS_SECTION_ID,
    userSectionId("Work"),
  ];

  it("uses natural order when no preference exists", () => {
    expect(orderedSidebarSections(natural, [])).toEqual(natural);
  });

  it("preserves a user move and inserts a newly visible bucket naturally", () => {
    const withoutBotChats = natural.filter((id) => id !== BOT_CHATS_SECTION_ID);
    const saved = [userSectionId("Work"), PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOTS_SECTION_ID];
    expect(orderedSidebarSections(withoutBotChats, saved)).toEqual(saved);
    expect(orderedSidebarSections(natural, saved)).toEqual([
      userSectionId("Work"),
      PINNED_SECTION_ID,
      CHANNELS_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      BOTS_SECTION_ID,
    ]);
  });

  it("moves and drops sections without wrapping", () => {
    expect(moveSection(natural, CHANNELS_SECTION_ID, -1)).toEqual([
      CHANNELS_SECTION_ID,
      PINNED_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      BOTS_SECTION_ID,
      userSectionId("Work"),
    ]);
    expect(moveSection(natural, PINNED_SECTION_ID, -1)).toBe(natural);
    expect(placeSection(natural, BOTS_SECTION_ID, PINNED_SECTION_ID, "before")).toEqual([
      BOTS_SECTION_ID,
      PINNED_SECTION_ID,
      CHANNELS_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      userSectionId("Work"),
    ]);
  });

  it("retains empty sections in their saved slot", () => {
    const visible = natural.filter((id) => id !== CHANNELS_SECTION_ID);
    expect(mergeSectionOrder(natural, visible)).toEqual(natural);
  });

  it("retains leading empty sections before their next visible successor", () => {
    const work = userSectionId("Work");
    const personal = userSectionId("Personal");
    const saved = [work, personal, PINNED_SECTION_ID, CHANNELS_SECTION_ID];

    expect(mergeSectionOrder(saved, [PINNED_SECTION_ID, CHANNELS_SECTION_ID])).toEqual(saved);
  });

  it("preserves a leading empty section when visible sections were reordered", () => {
    const work = userSectionId("Work");
    const saved = [work, PINNED_SECTION_ID, CHANNELS_SECTION_ID];

    expect(mergeSectionOrder(saved, [CHANNELS_SECTION_ID, PINNED_SECTION_ID])).toEqual([
      CHANNELS_SECTION_ID,
      work,
      PINNED_SECTION_ID,
    ]);
  });
});

describe("sidebar row stamp", () => {
  // Fixed points, so the boundaries are the subject rather than the clock.
  const now = new Date(2026, 8, 8, 10, 0).getTime(); // Tue 8 Sep 2026, 10:00
  const at = (day: number, hour = 9, minute = 30) => new Date(2026, 8, day, hour, minute).getTime();

  it("moves from the time, through yesterday and the weekday, to the date", () => {
    setLocale("en");
    expect(sidebarStamp(at(8, 9, 30), now)).toMatch(/9:30/);
    expect(sidebarStamp(at(7), now)).toBe("Yesterday");
    expect(sidebarStamp(at(4), now)).toBe("Friday");
    // seven days back is no longer "this week", so it becomes a date
    expect(sidebarStamp(at(1), now)).toBe("09/01");
  });

  it("counts calendar days, not elapsed hours", () => {
    setLocale("en");
    // one minute earlier, but the day before: yesterday, never "23:59"
    expect(sidebarStamp(new Date(2026, 8, 7, 23, 59).getTime(), new Date(2026, 8, 8, 0, 1).getTime())).toBe(
      "Yesterday",
    );
  });

  it("reads a clock that runs ahead as today rather than as an error", () => {
    setLocale("en");
    expect(sidebarStamp(at(9, 11, 15), now)).toMatch(/11:15/);
  });
});

describe("row order", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("follows the saved order and keeps unseen rows next to their neighbours", () => {
    // "b" was never dragged, so it lands beside the neighbour it still has:
    // ahead of "c", because the saved order put "c" before "a"
    expect(orderedSidebarRows(rows, ["c", "a"]).map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(orderedSidebarRows(rows, []).map((row) => row.id)).toEqual(["a", "b", "c"]);
    // a saved id that no longer exists is ignored, not rendered
    expect(orderedSidebarRows(rows, ["gone", "b"]).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("moves a row only against a neighbour from its own list", () => {
    // "b" and "e" share a saved order but sit in different sections
    const saved = ["a", "b", "c", "d", "e"];
    const list = ["b", "d"];
    expect(moveRowWithinList(saved, list, "d", -1)).toEqual(["a", "d", "b", "c", "e"]);
    // at the end of its own list nothing happens, even though "e" follows it
    expect(moveRowWithinList(saved, list, "d", 1)).toEqual(saved);
    expect(moveRowWithinList(saved, list, "b", -1)).toEqual(saved);
    // a row outside the list cannot be moved by it
    expect(moveRowWithinList(saved, list, "c", 1)).toEqual(saved);
  });
});
