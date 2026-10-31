import { describe, expect, it } from "vitest";

import { parseDeviceView, SEES_NOTHING, storedDeviceView, type DeviceView } from "../shared/device-view.ts";
import { frameForMember, memberBot, roomMemberMissing, routineRunVisible, routineVisible, VisibleSet, webhookVisible, type FrameContext, type StreamSeen, type Viewer } from "./bot-visibility.ts";

const bots = [
  { id: "ops1", threadId: "t-ops1", mainThreadId: "t-ops1", section: "Ops", tasks: [{ threadId: "t-ops1" }, { threadId: "t-ops1-b" }] },
  { id: "ops2", threadId: "t-ops2", section: " Ops ", tasks: [{ threadId: "t-ops2" }] },
  { id: "hr", threadId: "t-hr", section: "People", avatarUrl: "/api/attachments/hr.png", tasks: [{ threadId: "t-hr" }] },
  { id: "gen", threadId: "t-gen", tasks: [{ threadId: "t-gen" }] },
  { id: "secret", threadId: "t-secret", section: "Ops", visibility: "admins" },
];
const groups = [
  { id: "room-ops", threadId: "t-room-ops", memberIds: ["ops1", "ops2"], section: "Ops", tasks: [{ threadId: "t-room-ops-2" }] },
  { id: "room-mixed", threadId: "t-room-mixed", memberIds: ["ops1", "hr"], section: "Ops" },
  { id: "room-ops1", threadId: "t-room-ops1", memberIds: ["ops1"] },
];
const sections = ["Ops", "People", ""];

const lensed = (view: DeviceView): Viewer => ({ kind: "member", view });
const only = (targets: Partial<DeviceView>): DeviceView => ({ sections: [], bots: [], groups: [], ...targets });
const set = (viewer: Viewer) => new VisibleSet(bots, groups, viewer);

describe("device view values", () => {
  it("reads an admin's input, one target or several", () => {
    expect(parseDeviceView(null)).toEqual({ ok: true, view: null });
    expect(parseDeviceView({ section: " Ops " })).toEqual({ ok: true, view: only({ sections: ["Ops"] }) });
    expect(parseDeviceView({ section: "" })).toEqual({ ok: true, view: only({ sections: [""] }) });
    expect(parseDeviceView({ bot: "ops1" })).toEqual({ ok: true, view: only({ bots: ["ops1"] }) });
    expect(parseDeviceView({ group: "room-ops" })).toEqual({ ok: true, view: only({ groups: ["room-ops"] }) });
    expect(parseDeviceView({ sections: ["Ops", " Ops", "People"], bots: ["hr"], groups: ["room-ops", "room-mixed"] }))
      .toEqual({ ok: true, view: { sections: ["Ops", "People"], bots: ["hr"], groups: ["room-ops", "room-mixed"] } });
    expect(parseDeviceView({ groups: ["room-ops"] })).toEqual({ ok: true, view: only({ groups: ["room-ops"] }) });
    expect(parseDeviceView(undefined).ok).toBe(false);
    expect(parseDeviceView({}).ok).toBe(false);
    expect(parseDeviceView({ sections: [], bots: [], groups: [] }).ok).toBe(false);
    expect(parseDeviceView({ bot: "a", group: "b" }).ok).toBe(false);
    expect(parseDeviceView({ bot: "a", groups: ["b"] }).ok).toBe(false);
    expect(parseDeviceView({ bot: "../x" }).ok).toBe(false);
    expect(parseDeviceView({ bots: ["ok", "../x"] }).ok).toBe(false);
    expect(parseDeviceView({ bots: "ops1" }).ok).toBe(false);
    expect(parseDeviceView({ bots: null, groups: ["room-ops"] }).ok).toBe(false);
    expect(parseDeviceView({ team: "x" }).ok).toBe(false);
    expect(parseDeviceView({ section: "x".repeat(81) }).ok).toBe(false);
    expect(parseDeviceView({ sections: [], bots: [], groups: [] }, { allowNothing: true })).toEqual({ ok: true, view: SEES_NOTHING });
    expect(parseDeviceView({ bots: [] }, { allowNothing: true })).toEqual({ ok: true, view: SEES_NOTHING });
    expect(parseDeviceView({}, { allowNothing: true }).ok).toBe(false);
    expect(parseDeviceView({ bots: Array.from({ length: 51 }, (_, i) => `b${i}`) }).ok).toBe(false);
  });

  it("fails closed on a stored view it cannot read", () => {
    expect(storedDeviceView(undefined)).toBeUndefined();
    expect(storedDeviceView({ bot: "ops1" })).toEqual(only({ bots: ["ops1"] }));
    expect(storedDeviceView({ sections: ["Ops"], bots: [], groups: ["room-ops"] })).toEqual(only({ sections: ["Ops"], groups: ["room-ops"] }));
    expect(storedDeviceView({ bot: "" })).toEqual(SEES_NOTHING);
    expect(storedDeviceView({ nonsense: 1 })).toEqual(SEES_NOTHING);
    expect(storedDeviceView("everything")).toEqual(SEES_NOTHING);
    expect(storedDeviceView(null)).toEqual(SEES_NOTHING);
    expect(storedDeviceView(SEES_NOTHING)).toEqual(SEES_NOTHING);
    expect(SEES_NOTHING).toEqual({ sections: [], bots: [], groups: [] });
  });
});

describe("a device limited to several targets", () => {
  it("sees the union: a department, a bot from elsewhere, and a room whose other bots stay members only", () => {
    const visible = set(lensed(only({ sections: ["People"], bots: ["gen"], groups: ["room-ops"] })));
    expect(["ops1", "ops2", "hr", "gen", "secret"].filter((id) => visible.bot(id))).toEqual(["ops1", "ops2", "hr", "gen"]);
    expect(["ops1", "ops2", "hr", "gen"].filter((id) => visible.reaches(id))).toEqual(["hr", "gen"]);
    expect(visible.group("room-ops")).toBe(true);
    expect(visible.group("room-mixed")).toBe(false);
    expect(visible.group("room-ops1")).toBe(false);
    expect(visible.thread("t-hr")).toBe(true);
    expect(visible.thread("t-gen")).toBe(true);
    expect(visible.thread("t-room-ops")).toBe(true);
    expect(visible.thread("t-ops1")).toBe(false);
    expect(visible.filtersThreads).toBe(true);
    expect(routineVisible({ botId: "ops1" }, visible)).toBe(false);
    expect(routineVisible({ botId: "hr" }, visible)).toBe(true);
    const shown = memberBot({ ...bots[0]!, messages: [{ id: "m1" }] }, visible) as Record<string, unknown>;
    expect(shown.threadId).toBeUndefined();
    expect((memberBot({ ...bots[2]! }, visible) as Record<string, unknown>).threadId).toBe("t-hr");
  });

  it("a bot listed by name keeps its own chat even when it is also in a listed room", () => {
    const visible = set(lensed(only({ bots: ["ops1"], groups: ["room-mixed"] })));
    expect(visible.reaches("ops1")).toBe(true);
    expect(visible.reaches("hr")).toBe(false);
    expect(visible.bot("hr")).toBe(true);
    expect(visible.thread("t-ops1")).toBe(true);
    expect(visible.thread("t-hr")).toBe(false);
    expect(visible.group("room-ops1")).toBe(true);
  });

  it("two rooms: both shown, every bot only as a member", () => {
    const visible = set(lensed(only({ groups: ["room-ops", "room-mixed"] })));
    expect(visible.group("room-ops")).toBe(true);
    expect(visible.group("room-mixed")).toBe(true);
    expect(visible.group("room-ops1")).toBe(false);
    expect(["ops1", "ops2", "hr"].every((id) => visible.bot(id) && !visible.reaches(id))).toBe(true);
  });
});

describe("a device limited to one department", () => {
  const visible = set(lensed(only({ sections: ["Ops"] })));

  it("sees that department's bots, their rooms and conversations, nothing else", () => {
    expect(visible.everything).toBe(false);
    expect(["ops1", "ops2", "hr", "gen", "secret"].filter((id) => visible.bot(id))).toEqual(["ops1", "ops2"]);
    expect(visible.reaches("ops1")).toBe(true);
    expect(visible.group("room-ops")).toBe(true);
    expect(visible.group("room-ops1")).toBe(true);
    expect(visible.group("room-mixed")).toBe(false);
    expect(visible.thread("t-ops1-b")).toBe(true);
    expect(visible.thread("t-room-ops-2")).toBe(true);
    expect(visible.thread("t-hr")).toBe(false);
    expect(visible.thread("t-room-mixed")).toBe(false);
    expect(visible.sections(sections)).toEqual(["Ops", ""]);
  });

  it("General is a department too", () => {
    const general = set(lensed(only({ sections: [""] })));
    expect(["ops1", "ops2", "hr", "gen", "secret"].filter((id) => general.bot(id))).toEqual(["gen"]);
    expect(general.sections(sections)).toEqual([""]);
  });

  it("a department that no longer exists shows nothing", () => {
    const gone = set(lensed(only({ sections: ["Finance"] })));
    expect(bots.some((bot) => gone.bot(bot.id))).toBe(false);
    expect(groups.some((group) => gone.group(group.id))).toBe(false);
    expect(gone.sections(sections)).toEqual([]);
  });

  it("never widens what the bot's own audience allows", () => {
    expect(visible.bot("secret")).toBe(false);
  });
});

describe("a device limited to one bot", () => {
  const visible = set(lensed(only({ bots: ["ops1"] })));

  it("sees that bot, its conversations and the rooms it is alone in", () => {
    expect(bots.filter((bot) => visible.bot(bot.id)).map((bot) => bot.id)).toEqual(["ops1"]);
    expect(visible.thread("t-ops1-b")).toBe(true);
    expect(visible.thread("t-ops2")).toBe(false);
    expect(visible.group("room-ops1")).toBe(true);
    expect(visible.group("room-ops")).toBe(false);
    expect(visible.sections(sections)).toEqual(["Ops", ""]);
  });

  it("a deleted bot leaves the device seeing nothing", () => {
    const gone = set(lensed(only({ bots: ["nobody"] })));
    expect(bots.some((bot) => gone.bot(bot.id))).toBe(false);
    expect(groups.some((group) => gone.group(group.id))).toBe(false);
    const nothing = set(lensed(SEES_NOTHING));
    expect(bots.some((bot) => nothing.bot(bot.id))).toBe(false);
  });

  it("serves another bot's avatar to nobody", () => {
    expect(visible.attachment("hr.png", () => [])).toBe(false);
  });
});

describe("a device limited to one group chat", () => {
  const visible = set(lensed(only({ groups: ["room-mixed"] })));

  it("sees that room and its conversations, and its bots only as members of it", () => {
    expect(visible.group("room-mixed")).toBe(true);
    expect(visible.group("room-ops")).toBe(false);
    expect(visible.group("room-ops1")).toBe(false);
    expect(visible.bot("ops1")).toBe(true);
    expect(visible.bot("hr")).toBe(true);
    expect(visible.bot("ops2")).toBe(false);
    expect(visible.reaches("ops1")).toBe(false);
    expect(visible.thread("t-room-mixed")).toBe(true);
    expect(visible.thread("t-ops1")).toBe(false);
    expect(visible.thread("t-hr")).toBe(false);
    expect(visible.filtersThreads).toBe(true);
    expect(visible.sections(sections)).toEqual(["Ops"]);
    expect(visible.attachment("hr.png", () => [])).toBe(true);
  });

  it("sends a member bot without any conversation of its own", () => {
    const shown = memberBot({ ...bots[0]!, messages: [{ id: "m1" }], hasMore: false, unread: true, tasks: [{ threadId: "t-ops1", unread: true }] }, visible) as Record<string, unknown>;
    expect(shown.tasks).toEqual([]);
    expect(shown.threadId).toBeUndefined();
    expect(shown.mainThreadId).toBeUndefined();
    expect(shown.messages).toBeUndefined();
    expect(shown.unread).toBe(false);
    expect(shown.roomOnly).toBe(true);
    const named = set(lensed(only({ bots: ["ops1"], groups: ["room-mixed"] })));
    expect((memberBot({ ...bots[0]! }, named) as Record<string, unknown>).roomOnly, "a later frame clears an earlier mark").toBe(false);
    expect(memberBot({ ...bots[0]! }, set(lensed(only({ sections: ["Ops"] }))))).not.toHaveProperty("roomOnly");
  });

  it("a room whose members include a bot the device's person may not see stays hidden", () => {
    const withSecret = new VisibleSet(bots, [{ id: "room-s", threadId: "t-room-s", memberIds: ["ops1", "secret"] }], lensed(only({ groups: ["room-s"] })));
    expect(withSecret.group("room-s")).toBe(false);
    expect(withSecret.bot("ops1")).toBe(false);
  });

  it("a deleted room shows nothing", () => {
    const gone = set(lensed(only({ groups: ["nope"] })));
    expect(bots.some((bot) => gone.bot(bot.id))).toBe(false);
    expect(groups.some((group) => gone.group(group.id))).toBe(false);
    expect(gone.sections(sections)).toEqual([]);
  });

  it("a member bot's own routines, runs and webhooks stay hidden; the room's routines show", () => {
    expect(routineVisible({ botId: "ops1" }, visible)).toBe(false);
    expect(routineRunVisible({ botId: "ops1" }, visible)).toBe(false);
    expect(webhookVisible({ botId: "hr" }, visible)).toBe(false);
    expect(routineVisible({ botId: "ops1", groupId: "room-mixed" }, visible)).toBe(true);
    const ctx: FrameContext = { visible, webhook: () => ({ botId: "hr" }), freshBot: () => undefined, freshGroup: () => undefined };
    const seen: StreamSeen = { bots: new Set(), groups: new Set() };
    expect(frameForMember({ kind: "routine", routine: { id: "r1", botId: "ops1", prompt: "private" } }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "routine.run", run: { id: "run1", botId: "ops1" } }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "webhook", webhook: { id: "w1", botId: "hr" } }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "webhook.attempt", attempt: { webhookId: "w1", preview: "payload" } }, ctx, seen)).toBeUndefined();
  });

  it("a member bot's own computer stays hidden; a bot listed by name keeps it", () => {
    const ctx: FrameContext = { visible, webhook: () => undefined, freshBot: () => undefined, freshGroup: () => undefined };
    const seen: StreamSeen = { bots: new Set(), groups: new Set() };
    expect(frameForMember({ kind: "computer", botId: "ops1", state: "running" }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "computer-control", botId: "ops1", held: true }, ctx, seen)).toBeUndefined();
    const named = set(lensed(only({ bots: ["ops1"], groups: ["room-mixed"] })));
    expect(frameForMember({ kind: "computer", botId: "ops1", state: "running" }, { ...ctx, visible: named }, seen)).toBeDefined();
  });

  it("a member bot's own data sheet and app triggers stay off the stream", () => {
    const ctx: FrameContext = { visible, webhook: () => undefined, freshBot: () => undefined, freshGroup: () => undefined };
    const seen: StreamSeen = { bots: new Set(), groups: new Set() };
    expect(frameForMember({ kind: "data", botId: "ops1", sheet: { cards: [{ title: "payroll" }] } }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "app-trigger", botId: "ops1", trigger: { prompt: "private" } }, ctx, seen)).toBeUndefined();
    expect(frameForMember({ kind: "app-trigger.attempt", botId: "hr", attempt: { preview: "From: boss" } }, ctx, seen)).toBeUndefined();
    const named = set(lensed(only({ bots: ["ops1"], groups: ["room-mixed"] })));
    expect(frameForMember({ kind: "data", botId: "ops1", sheet: { cards: [] } }, { ...ctx, visible: named }, seen)).toBeDefined();
  });
});

describe("a lensed device's live stream", () => {
  const ctx = (visible: VisibleSet): FrameContext => ({ visible, webhook: () => undefined, freshBot: () => undefined, freshGroup: () => undefined });
  const fresh = (): StreamSeen => ({ bots: new Set(), groups: new Set() });

  it("drops what is outside the view and withdraws a bot that leaves it", () => {
    const visible = set(lensed(only({ sections: ["Ops"] })));
    const seen = fresh();
    expect(frameForMember({ kind: "message", threadId: "t-hr" }, ctx(visible), seen)).toBeUndefined();
    expect(frameForMember({ kind: "message", threadId: "t-ops2" }, ctx(visible), seen)).toBeDefined();
    expect(frameForMember({ kind: "bot", bot: { id: "ops1", section: "Ops" } }, ctx(visible), seen)).toBeDefined();
    const moved = new VisibleSet(bots.map((bot) => (bot.id === "ops1" ? { ...bot, section: "People" } : bot)), groups, lensed(only({ sections: ["Ops"] })));
    expect(frameForMember({ kind: "bot", bot: { id: "ops1", section: "People" } }, ctx(moved), seen)).toEqual({ kind: "bot.deleted", botId: "ops1" });
  });

  it("a group-limited device never gets a member bot's own conversation", () => {
    const visible = set(lensed(only({ groups: ["room-mixed"] })));
    const seen = fresh();
    expect(frameForMember({ kind: "message", threadId: "t-ops1" }, ctx(visible), seen)).toBeUndefined();
    expect(frameForMember({ kind: "message", threadId: "t-room-mixed" }, ctx(visible), seen)).toBeDefined();
    const frame = frameForMember({ kind: "bot", bot: { id: "ops1", threadId: "t-ops1", tasks: [{ threadId: "t-ops1" }] } }, ctx(visible), seen) as { bot: Record<string, unknown> };
    expect(frame.bot.threadId).toBeUndefined();
    expect(frame.bot.tasks).toEqual([]);
  });
});

describe("a bot joining a group-limited device's room", () => {
  it("tells the stream to start over, since no bot frame will carry it", () => {
    const joined = new VisibleSet(bots, groups.map((group) => (group.id === "room-mixed" ? { ...group, memberIds: ["ops1", "hr", "ops2"] } : group)), lensed(only({ groups: ["room-mixed"] })));
    const seen: StreamSeen = { bots: new Set(["ops1", "hr"]), groups: new Set(["room-mixed"]) };
    expect(roomMemberMissing({ kind: "group", group: { id: "room-mixed", memberIds: ["ops1", "hr", "ops2"] } }, joined, seen)).toBe(true);
    expect(roomMemberMissing({ kind: "group", group: { id: "room-mixed", memberIds: ["ops1", "hr"] } }, set(lensed(only({ groups: ["room-mixed"] }))), seen)).toBe(false);
    expect(roomMemberMissing({ kind: "group", group: { id: "room-ops", memberIds: ["ops1", "ops2"] } }, joined, seen)).toBe(false);
    expect(roomMemberMissing({ kind: "group", group: { id: "room-ops", memberIds: ["ops1", "ops2"] } }, set(lensed(only({ sections: ["Ops"] }))), { bots: new Set(["ops1"]), groups: new Set() })).toBe(false);
  });
});
