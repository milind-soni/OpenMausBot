import { describe, expect, it } from "vitest";

import {
  BOT_CHATS_SECTION,
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  placeSection,
  orderedSectionNames,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  sidebarSectionLabel,
} from "./sidebar-layout";

describe("sidebar section order", () => {
  it("keeps a saved order and appends newly discovered names", () => {
    expect(orderedSectionNames(["Agents", "Strategy"], ["Strategy"])).toEqual(["Strategy", "Agents"]);
  });

  it("moves a section up and down without wrapping", () => {
    expect(moveSection(["A", "B", "C"], "B", -1)).toEqual(["B", "A", "C"]);
    expect(moveSection(["A", "B", "C"], "B", 1)).toEqual(["A", "C", "B"]);
    expect(moveSection(["A", "B", "C"], "A", -1)).toEqual(["A", "B", "C"]);
  });

  it("places a dragged section before or after a target", () => {
    expect(placeSection(["A", "B", "C"], "C", "A", "before")).toEqual(["C", "A", "B"]);
    expect(placeSection(["A", "B", "C"], "A", "C", "after")).toEqual(["B", "C", "A"]);
    expect(placeSection(["A", "B", "C"], "A", "A", "after")).toEqual(["A", "B", "C"]);
  });

  it("keeps empty sections in their saved slots when merging a visible drag", () => {
    const saved = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, "Agents"];
    const visible = ["Agents", PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID];
    expect(mergeSectionOrder(saved, visible)).toEqual([
      "Agents",
      PINNED_SECTION_ID,
      CHANNELS_SECTION_ID,
      BOT_CHATS_SECTION_ID,
      BOTS_SECTION_ID,
    ]);
  });

  it("promotes a user-only saved order to the full visible list", () => {
    const visible = [BOT_CHATS_SECTION_ID, PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOTS_SECTION_ID, "Agents"];
    expect(mergeSectionOrder(["Agents"], visible)).toEqual(visible);
  });

  it("uses present order when nothing is saved", () => {
    const present = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, "Agents"];
    expect(orderedSidebarSections(present, [])).toEqual(present);
  });

  it("inserts new built-in buckets at their default slots when the saved order is only user sections", () => {
    const present = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, "Agents"];
    expect(orderedSidebarSections(present, ["Agents"])).toEqual(present);
  });

  it("keeps a user move of Projects below Agents", () => {
    const present = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, "Agents"];
    const saved = [PINNED_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, "Agents", CHANNELS_SECTION_ID];
    expect(orderedSidebarSections(present, saved)).toEqual(saved);
  });

  it("restores an empty section to its saved place when it comes back", () => {
    const saved = ["Agents", PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID];
    const withoutBots = ["Agents", PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID];
    expect(orderedSidebarSections(withoutBots, saved)).toEqual(withoutBots);
    expect(orderedSidebarSections(saved, saved)).toEqual(saved);
  });

  it("labels built-in buckets for the divider", () => {
    expect(sidebarSectionLabel(PINNED_SECTION_ID)).toBe("Pinned");
    expect(sidebarSectionLabel(CHANNELS_SECTION_ID)).toBe("Projects");
    expect(sidebarSectionLabel("Agents")).toBe("Agents");
  });
});

describe("partitionSidebarBots", () => {
  it("lifts pinned bots to sit under the unsectioned chief", () => {
    const parts = partitionSidebarBots([
      { id: "trace", chiefOfStaff: true },
      { id: "forge", pinned: true, section: "Agents" },
      { id: "anchor", section: "Agents" },
      { id: "vera" },
    ]);
    expect(parts.unsectionedChief?.id).toBe("trace");
    expect(parts.pinnedUnderChief.map((bot) => bot.id)).toEqual(["forge"]);
    expect(parts.sectionedBots.map((bot) => bot.id)).toEqual(["anchor"]);
    expect(parts.unsectionedBots.map((bot) => bot.id)).toEqual(["vera"]);
  });
});

describe("partitionSidebarGroups", () => {
  it("lifts bot DMs into Bot Chats even when they still carry an Agents section", () => {
    const parts = partitionSidebarGroups([
      { id: "launch", section: "Agents" },
      { id: "dm-stale", dm: true, section: "Agents" },
      { id: "dm-new", dm: true, section: BOT_CHATS_SECTION },
      { id: "general" },
    ]);
    expect(parts.botChats.map((group) => group.id)).toEqual(["dm-stale", "dm-new"]);
    expect(parts.sectionedRooms.map((group) => group.id)).toEqual(["launch"]);
    expect(parts.unsectionedRooms.map((group) => group.id)).toEqual(["general"]);
  });
});
