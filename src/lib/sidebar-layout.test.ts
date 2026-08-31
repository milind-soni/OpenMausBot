import { describe, expect, it } from "vitest";

import {
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sidebarLayoutInteractive,
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
    expect(sidebarSectionLabel(CHANNELS_SECTION_ID)).toBe("Channels");
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
