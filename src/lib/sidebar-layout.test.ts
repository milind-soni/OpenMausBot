import { describe, expect, it } from "vitest";

import {
  activeBotsFirst,
  BOT_CHATS_SECTION_ID,
  BOTS_SECTION_ID,
  CHANNELS_SECTION_ID,
  PINNED_SECTION_ID,
  UNREAD_SECTION_ID,
  mergeSectionOrder,
  moveSection,
  orderedSidebarSections,
  partitionSidebarBots,
  partitionSidebarGroups,
  pinnedCircleThreadListVisible,
  placeSection,
  sidebarConnectorPreview,
  sidebarLayoutInteractive,
  sidebarGoalRunPreview,
  sidebarSectionCollapsed,
  sidebarSectionLabel,
  simpleOrderedSections,
  simpleSidebarSections,
  sectionsInUse,
  sidebarBotRows,
  nextUnreadHold,
  unreadBotsApart,
  unreadSinceByBot,
  userSectionId,
  userSectionName,
  withPrimaryTile,
  withUnreadSection,
} from "./sidebar-layout";

describe("sidebar virtual sections", () => {
  it("keeps reserved labels separate from identically named user sections", () => {
    for (const name of ["Pinned", "pinned", "channels", "bots", "bot-chats", "Bot Chats"]) {
      const id = userSectionId(name);
      expect([PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID]).not.toContain(id);
      expect(userSectionName(id)).toBe(name);
      expect(sidebarSectionLabel(id)).toBe(name);
    }
    expect(sidebarSectionLabel(CHANNELS_SECTION_ID)).toBe("Group chats");
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

  it("lists every bucket in the order the bots arrive, never by name", () => {
    // The server owns this order (PUT /api/bots/order); a reorder made on a phone must show up here unchanged.
    const parts = partitionSidebarBots([
      { id: "zed", name: "Zed", pinned: true },
      { id: "yak", name: "Yak", section: "Work" },
      { id: "xon", name: "Xon" },
      { id: "amy", name: "Amy", pinned: true },
      { id: "bob", name: "Bob", section: "Work" },
      { id: "cat", name: "Cat" },
    ]);
    expect(parts.pinnedBots.map((bot) => bot.id)).toEqual(["zed", "amy"]);
    expect(parts.sectionedBots.map((bot) => bot.id)).toEqual(["yak", "bob"]);
    expect(parts.unsectionedBots.map((bot) => bot.id)).toEqual(["xon", "cat"]);
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

  it("keeps unpinned section Chiefs in their actual section", () => {
    const chief = { id: "chief", chiefOfStaff: true, section: "Work" };
    const parts = partitionSidebarBots([chief]);
    expect(parts.sectionChiefs).toEqual([chief]);
    expect(parts.pinnedBots).toEqual([]);
  });

  it("lifts pinned bots from every group, the main Chief too, when pins are universal", () => {
    const workChief = { id: "work-chief", chiefOfStaff: true, section: "Work", pinned: true };
    const home = { id: "home", section: "Home", pinned: true };
    const looseChief = { id: "loose", chiefOfStaff: true, pinned: true };
    const stay = { id: "stay", section: "Work" };
    const hidden = { id: "hidden", section: "Home", pinned: true, hidden: true };
    const parts = partitionSidebarBots([workChief, home, looseChief, stay, hidden], { universalPins: true });
    expect(parts.pinnedBots.map((bot) => bot.id)).toEqual(["work-chief", "home", "loose"]);
    expect(parts.sectionChiefs).toEqual([]);
    expect(parts.unsectionedChief).toBeNull();
    expect(parts.sectionedBots).toEqual([stay]);
    expect(workChief.section).toBe("Work");
    expect(home.section).toBe("Home");
  });

  it("finds the viewer's own hidden MausBot in a search, never someone else's", () => {
    const mine = { id: "nova", defaultBot: {}, sidebarHidden: true, section: "C Suite" };
    const theirs = { id: "theirs", defaultBot: { person: "sam@example.com" }, section: "C Suite" };
    expect(partitionSidebarBots([mine, theirs], { viewerEmail: null }).sectionedBots).toEqual([]);
    expect(partitionSidebarBots([mine, theirs], { viewerEmail: null, searching: true }).sectionedBots).toEqual([mine]);
    const plain = { id: "plain", sidebarHidden: true, section: "C Suite" };
    expect(partitionSidebarBots([plain], { viewerEmail: null }).sectionedBots).toEqual([plain]);
    const hiddenMaus = { id: "maus", chiefOfStaff: true, sidebarHidden: true, defaultBot: {} };
    const sharedChief = { id: "shared", chiefOfStaff: true };
    const found = partitionSidebarBots([hiddenMaus, sharedChief], { viewerEmail: null, searching: true });
    expect([found.unsectionedChief, ...found.unsectionedBots]).toEqual([hiddenMaus, sharedChief]);
    expect(partitionSidebarBots([hiddenMaus, sharedChief], { viewerEmail: null }).unsectionedBots).toEqual([]);
  });

  it("lists a group's pinned Chief with the pinned bots on every client; the main Chief keeps its own top slot", () => {
    const bots = [
      { id: "work-chief", chiefOfStaff: true, section: "Work", pinned: true },
      { id: "home-chief", chiefOfStaff: true, section: "Home", pinned: true },
      { id: "main-chief", chiefOfStaff: true, pinned: true },
      { id: "plain-pinned", pinned: true },
      { id: "unpinned-chief", chiefOfStaff: true, section: "Work" },
      { id: "member", section: "Work" },
    ];
    const local = partitionSidebarBots(bots);
    expect(local.pinnedBots.map((bot) => bot.id)).toEqual(["work-chief", "home-chief", "plain-pinned"]);
    expect(local.unsectionedChief?.id).toBe("main-chief");
    expect(local.sectionChiefs.map((bot) => bot.id)).toEqual(["unpinned-chief"]);
    expect(local.sectionedBots.map((bot) => bot.id)).toEqual(["member"]);
    const universal = partitionSidebarBots(bots, { universalPins: true });
    expect(universal.pinnedBots.map((bot) => bot.id)).toEqual(["work-chief", "home-chief", "main-chief", "plain-pinned"]);
    expect(universal.unsectionedChief).toBeNull();
    expect(universal.sectionChiefs.map((bot) => bot.id)).toEqual(["unpinned-chief"]);
  });

  it("shows pinned-circle thread rows only while the circle grid is showing", () => {
    expect(pinnedCircleThreadListVisible(true, "comfortable", 1)).toBe(true);
    expect(pinnedCircleThreadListVisible(true, "comfortable", 2)).toBe(true);
    expect(pinnedCircleThreadListVisible(false, "comfortable", 1)).toBe(false);
    expect(pinnedCircleThreadListVisible(true, "icons", 1)).toBe(false);
    expect(pinnedCircleThreadListVisible(true, "comfortable", 0)).toBe(false);
  });

  it("forces filtered and icon-only views open and non-reorderable", () => {
    expect(sidebarLayoutInteractive("comfortable", "")).toBe(true);
    expect(sidebarLayoutInteractive("comfortable", "writer")).toBe(false);
    expect(sidebarLayoutInteractive("icons", "")).toBe(false);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "comfortable", "")).toBe(true);
    expect(sidebarSectionCollapsed(PINNED_SECTION_ID, [PINNED_SECTION_ID], "comfortable", "writer")).toBe(false);
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

  it("previews a connection card by its app and state, not the phone fallback line", () => {
    const say = (key: string) => ({
      "connectors.card.connected": "Connected",
      "connectors.card.waiting": "Waiting for sign-in…",
      "connectors.card.connectSecurely": "Connect securely",
    })[key] ?? key;
    const card = { label: "GitHub", status: "required" as const };
    expect(sidebarConnectorPreview(card, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "failed" }, say)).toBe("GitHub · Connect securely");
    expect(sidebarConnectorPreview({ ...card, status: "authorizing" }, say)).toBe("GitHub · Waiting for sign-in…");
    expect(sidebarConnectorPreview({ ...card, status: "connected" }, say)).toBe("GitHub · Connected");
    expect(sidebarConnectorPreview({ ...card, dismissed: true }, say)).toBe("GitHub");
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

describe("Simple-mode section order", () => {
  const work = userSectionId("Work");
  const home = userSectionId("Home");

  it("puts Pinned, the bots, group chats and bot threads first, then the departments in their saved order", () => {
    const natural = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, BOTS_SECTION_ID, work];
    expect(simpleSidebarSections(natural)).toEqual([PINNED_SECTION_ID, BOTS_SECTION_ID, CHANNELS_SECTION_ID, BOT_CHATS_SECTION_ID, work]);
    expect(simpleSidebarSections([work, CHANNELS_SECTION_ID, BOTS_SECTION_ID])).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, work]);
    const saved = orderedSidebarSections([CHANNELS_SECTION_ID, BOTS_SECTION_ID, work, home], [home, CHANNELS_SECTION_ID, BOTS_SECTION_ID, work]);
    expect(simpleSidebarSections(saved)).toEqual([BOTS_SECTION_ID, CHANNELS_SECTION_ID, home, work]);
  });

  it("keeps that default until a section is moved in Simple, then follows Simple's own saved order", () => {
    const ordered = [PINNED_SECTION_ID, CHANNELS_SECTION_ID, BOTS_SECTION_ID, work, home];
    expect(simpleOrderedSections(ordered, [])).toEqual([PINNED_SECTION_ID, BOTS_SECTION_ID, CHANNELS_SECTION_ID, work, home]);
    const moved = [CHANNELS_SECTION_ID, home, PINNED_SECTION_ID, BOTS_SECTION_ID, work];
    expect(simpleOrderedSections(ordered, moved)).toEqual(moved);
  });

  it("can move any section, the bots and group chats included, above the others", () => {
    const shown = simpleOrderedSections([CHANNELS_SECTION_ID, BOTS_SECTION_ID, work], []);
    expect(moveSection(shown, work, -1)).toEqual([BOTS_SECTION_ID, work, CHANNELS_SECTION_ID]);
    expect(placeSection(shown, CHANNELS_SECTION_ID, BOTS_SECTION_ID, "before")).toEqual([CHANNELS_SECTION_ID, BOTS_SECTION_ID, work]);
  });

  it("slots a department added after a Simple move in beside its neighbours from the default", () => {
    const saved = [work, CHANNELS_SECTION_ID, BOTS_SECTION_ID];
    expect(simpleOrderedSections([CHANNELS_SECTION_ID, BOTS_SECTION_ID, work, home], saved)).toEqual([work, home, CHANNELS_SECTION_ID, BOTS_SECTION_ID]);
  });
});

describe("the primary tile", () => {
  const bot = (id: string, extra: Partial<{ chiefOfStaff: boolean; pinned: boolean; section: string }> = {}) => ({ id, ...extra });

  it("is the unsectioned Chief of Staff, pinned or not, taken out of the lists", () => {
    const parts = partitionSidebarBots([bot("chief", { chiefOfStaff: true, pinned: true }), bot("atlas", { pinned: true }), bot("bea")], { universalPins: true });
    const tiled = withPrimaryTile(parts, undefined);
    expect(tiled.primary?.id).toBe("chief");
    expect(tiled.unsectionedChief).toBeNull();
    expect(tiled.pinnedBots.map((candidate) => candidate.id)).toEqual(["atlas"]);
    expect(tiled.unsectionedBots.map((candidate) => candidate.id)).toEqual(["bea"]);
  });

  it("falls back to the person's MausBot, and leaves a department's Chief in its department", () => {
    const parts = partitionSidebarBots([bot("lead", { chiefOfStaff: true, section: "Work" }), bot("mausbot"), bot("bea")]);
    const tiled = withPrimaryTile(parts, "mausbot");
    expect(tiled.primary?.id).toBe("mausbot");
    expect(tiled.unsectionedBots.map((candidate) => candidate.id)).toEqual(["bea"]);
    expect(tiled.sectionChiefs.map((candidate) => candidate.id)).toEqual(["lead"]);
    expect(withPrimaryTile(parts, undefined).primary).toBeNull();
  });
});

describe("active bots first", () => {
  it("moves active bots up inside each list, keeps everyone's order, and touches nothing else", () => {
    const parts = { pinnedBots: ["p1", "p2", "p3"], sectionedBots: ["w1", "h1", "w2"], unsectionedBots: ["a", "b", "c"], other: "kept" };
    const active = new Set(["p3", "w2", "h1", "c", "b"]);
    expect(activeBotsFirst(parts, (id) => active.has(id))).toEqual({
      pinnedBots: ["p3", "p1", "p2"],
      sectionedBots: ["h1", "w2", "w1"],
      unsectionedBots: ["b", "c", "a"],
    });
    expect(parts.unsectionedBots).toEqual(["a", "b", "c"]);
    expect(parts.pinnedBots).toEqual(["p1", "p2", "p3"]);
    expect(parts.sectionedBots).toEqual(["w1", "h1", "w2"]);
  });
});

describe("the unread section", () => {
  const read = (id: string) => ({ id, unread: false });
  const thread = (unread: boolean, updatedAt?: number, extra: { routineRunId?: string; archivedAt?: number } = {}) => ({ unread, updatedAt, createdAt: 1, ...extra });

  it("takes unread bots out of their lists, newest unread conversation first, and leaves the lists otherwise as they were", () => {
    const parts = {
      sectionChiefs: [{ id: "lead", unread: true, tasks: [thread(true, 50), thread(false, 90)] }],
      sectionedBots: [read("w1"), { id: "w2", unread: true, tasks: [thread(true, 70), thread(true, 10)] }],
      unsectionedBots: [{ id: "a", unread: true, messages: [{ at: 5 }, { at: 60 }] }, read("b"), { id: "c", unread: true }],
    };
    const apart = unreadBotsApart(parts);
    expect(apart.unreadBots.map((bot) => bot.id)).toEqual(["w2", "a", "lead", "c"]);
    expect(apart.sectionChiefs).toEqual([]);
    expect(apart.sectionedBots.map((bot) => bot.id)).toEqual(["w1"]);
    expect(apart.unsectionedBots.map((bot) => bot.id)).toEqual(["b"]);
    expect(parts.unsectionedBots).toHaveLength(3);
  });

  it("lists a read bot waiting on the person with the unread ones, first, counts it, and leaves it out of what a drag arranges", () => {
    const saved = { pinnedBots: [], sectionChiefs: [], sectionedBots: [read("w1"), read("asker")], unsectionedBots: [{ id: "u", unread: true, messages: [{ at: 99 }] }, read("b")] };
    const waiting = (bot: { id: string }) => bot.id === "asker";
    const rows = sidebarBotRows(saved, () => false, true, null, waiting);
    const ids = (bots: { id: string }[]) => bots.map((bot) => bot.id);
    expect(ids(rows.unreadBots)).toEqual(["asker", "u"]);
    expect(rows.unreadCount).toBe(2);
    expect([ids(rows.sectionedBots), ids(rows.inPlace.sectionedBots)]).toEqual([["w1"], ["w1"]]);
    expect(ids(sidebarBotRows(saved, () => false, true).unreadBots)).toEqual(["u"]);
    expect(ids(sidebarBotRows(saved, () => false, false, null, waiting).sectionedBots)).toEqual(["w1", "asker"]);
  });

  it("counts a bot unread exactly as its row's dot does: a routine run or an archived conversation does not", () => {
    const parts = {
      sectionChiefs: [],
      sectionedBots: [],
      unsectionedBots: [
        { id: "run", unread: true, tasks: [thread(true, 9, { routineRunId: "r" })] },
        { id: "old", unread: true, tasks: [thread(true, 9, { archivedAt: 3 })] },
        { id: "flag", unread: true, tasks: [thread(false, 9)] },
      ],
    };
    expect(unreadBotsApart(parts).unreadBots).toEqual([]);
  });

  it("moves nothing while it is off", () => {
    const parts = { sectionChiefs: [], sectionedBots: [], unsectionedBots: [{ id: "a", unread: true }] };
    expect(unreadBotsApart(parts, false)).toEqual({ ...parts, unreadBots: [] });
  });

  it("arranges the saved order of the rows left in place, whatever is shown first or listed as unread", () => {
    const unread = (id: string) => ({ id, unread: true });
    const saved = { pinnedBots: [read("p1"), read("p2")], sectionChiefs: [unread("lead")], sectionedBots: [read("w1"), unread("w2"), read("w3")], unsectionedBots: [read("a"), unread("u"), read("b")] };
    const rows = sidebarBotRows(saved, (bot) => ["b", "w3", "p2"].includes(bot.id));
    const ids = (bots: { id: string }[]) => bots.map((bot) => bot.id);
    expect([ids(rows.pinnedBots), ids(rows.unsectionedBots), ids(rows.sectionedBots)]).toEqual([["p2", "p1"], ["b", "a"], ["w3", "w1"]]);
    expect(ids(rows.unreadBots).sort()).toEqual(["lead", "u", "w2"]);
    expect(ids(rows.filed)).toEqual(["w3", "w1", "w2", "lead"]);
    expect([ids(rows.inPlace.unsectionedBots), ids(rows.inPlace.sectionedBots)]).toEqual([["a", "b"], ["w1", "w3"]]);

    const searching = sidebarBotRows(saved, () => false, false);
    expect(searching.unreadBots).toEqual([]);
    expect(ids(searching.inPlace.unsectionedBots)).toEqual(["a", "u", "b"]);
  });

  it("keeps the bot opened from Unread listed there, in its place, until another chat is open", () => {
    const bots = [{ id: "a", unread: true, messages: [{ at: 30 }] }, { id: "b", unread: true, messages: [{ at: 20 }] }, { id: "c", unread: true, messages: [{ at: 10 }] }];
    const before = unreadSinceByBot(bots);
    expect([...before]).toEqual([["a", 30], ["b", 20], ["c", 10]]);

    const opened = bots.map((bot) => (bot.id === "b" ? { ...bot, unread: false, messages: [{ at: 20 }, { at: 99 }] } : bot));
    const held = nextUnreadHold(null, "b", before);
    expect(held).toEqual({ id: "b", since: 20 });
    const parts = { sectionChiefs: [], sectionedBots: [], unsectionedBots: opened };
    const apart = unreadBotsApart(parts, true, held);
    expect(apart.unreadBots.map((bot) => bot.id)).toEqual(["a", "b", "c"]);
    expect(apart.unsectionedBots).toEqual([]);
    expect(unreadBotsApart(parts).unreadBots.map((bot) => bot.id)).toEqual(["a", "c"]);

    const after = unreadSinceByBot(opened);
    expect(nextUnreadHold(held, "b", after)).toBe(held);
    expect(nextUnreadHold(held, "a", after)).toEqual({ id: "a", since: 30 });
    expect(nextUnreadHold(held, "room", after)).toBeNull();
    expect(nextUnreadHold(held, null, after)).toBeNull();
    expect(nextUnreadHold(null, "b", after)).toBeNull();
  });

  it("lists a held bot by the normal rule again once it is marked unread or a new message arrives", () => {
    const held = { id: "b", since: 20 };
    const bots = (b: { unread: boolean; at: number }) => [{ id: "a", unread: true, messages: [{ at: 30 }] }, { id: "b", unread: b.unread, messages: [{ at: b.at }] }];
    const listed = (b: { unread: boolean; at: number }) => unreadBotsApart({ sectionChiefs: [], sectionedBots: [], unsectionedBots: bots(b) }, true, held).unreadBots.map((bot) => bot.id);
    expect(listed({ unread: false, at: 20 })).toEqual(["a", "b"]);
    expect(listed({ unread: true, at: 20 })).toEqual(["a", "b"]);
    expect(listed({ unread: true, at: 40 })).toEqual(["b", "a"]);
    expect(nextUnreadHold(held, "b", unreadSinceByBot(bots({ unread: true, at: 40 })))).toEqual({ id: "b", since: 40 });
  });

  it("ends the hold when another conversation of the same bot is open, and holds the bot again from one that was unread", () => {
    const none = new Map<string, number>();
    const held = nextUnreadHold(null, "b", new Map([["b", 20]]), "first");
    expect(held).toEqual({ id: "b", since: 20, chat: "first" });
    expect(nextUnreadHold(held, "b", none, "first")).toBe(held);
    expect(nextUnreadHold(held, "b", none, "second")).toBeNull();
    expect(nextUnreadHold(held, "b", none, "new-chat-b")).toBeNull();

    const stillUnread = new Map([["b", 50]]);
    const second = nextUnreadHold(held, "b", stillUnread, "second");
    expect(second).toEqual({ id: "b", since: 50, chat: "second" });
    expect(nextUnreadHold(second, "b", none, "second")).toBe(second);
    expect(nextUnreadHold(second, "b", none, "first")).toBeNull();
  });

  it("leaves a held row out of what a drag or Alt+Up/Down arranges", () => {
    const saved = { pinnedBots: [], sectionChiefs: [], sectionedBots: [read("w1"), read("w2")], unsectionedBots: [read("a"), read("u"), read("b")] };
    const rows = sidebarBotRows(saved, () => false, true, { id: "u", since: 5 });
    const ids = (bots: { id: string }[]) => bots.map((bot) => bot.id);
    expect(ids(rows.unreadBots)).toEqual(["u"]);
    expect([ids(rows.unsectionedBots), ids(rows.inPlace.unsectionedBots), ids(rows.inPlace.sectionedBots)]).toEqual([["a", "b"], ["a", "b"], ["w1", "w2"]]);
    expect(ids(sidebarBotRows(saved, () => false, false, { id: "u", since: 5 }).inPlace.unsectionedBots)).toEqual(["a", "u", "b"]);
  });

  it("lists a department that only a shown bot or room names, after the given ones and once", () => {
    expect(sectionsInUse(["Work"], [{ section: "Ops" }, { section: "Work" }, { section: "Ops" }, {}, { section: null }])).toEqual(["Work", "Ops"]);
  });

  it("goes under the pinned bots when they lead the list, at the top otherwise, and nowhere with nothing unread", () => {
    expect(withUnreadSection([PINNED_SECTION_ID, BOTS_SECTION_ID], true)).toEqual([PINNED_SECTION_ID, UNREAD_SECTION_ID, BOTS_SECTION_ID]);
    expect(withUnreadSection([BOTS_SECTION_ID, PINNED_SECTION_ID], true)).toEqual([UNREAD_SECTION_ID, BOTS_SECTION_ID, PINNED_SECTION_ID]);
    expect(withUnreadSection([], true)).toEqual([UNREAD_SECTION_ID]);
    expect(withUnreadSection([BOTS_SECTION_ID], false)).toEqual([BOTS_SECTION_ID]);
    expect(sidebarSectionLabel(UNREAD_SECTION_ID)).toBe("Unread");
  });
});
