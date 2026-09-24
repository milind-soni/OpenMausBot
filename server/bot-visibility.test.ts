import { describe, expect, it } from "vitest";

import {
  audienceWithin,
  intersectAudience,
  narrowestAudience,
  frameForMember,
  memberBody,
  memberBot,
  noteSeen,
  parseVisibility,
  pathSubject,
  roomFeeds,
  routineVisible,
  sameAudience,
  SEES_EVERYTHING,
  storedVisibility,
  viewerSees,
  VisibleSet,
  type FrameContext,
  type StreamSeen,
  type Viewer,
} from "./bot-visibility.ts";

const ADA: Viewer = { kind: "member", email: "ada@example.test" };
const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const NOBODY: Viewer = { kind: "member" };

const bots = [
  { id: "pub", threadId: "t-pub", section: "Ops", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2" }] },
  { id: "hr", threadId: "t-hr", section: "People", visibility: { people: ["ada@example.test"] }, avatarUrl: "/api/attachments/hr.png", tasks: [{ threadId: "t-hr" }] },
  { id: "adm", threadId: "t-adm", section: "People", visibility: "admins" },
  { id: "corp", threadId: "t-corp", visibility: { people: ["@example.test"] } },
];
const groups = [
  { id: "room-pub", threadId: "t-room-pub", memberIds: ["pub"], section: "Ops" },
  { id: "room-mixed", threadId: "t-room-mixed", memberIds: ["pub", "hr"], tasks: [{ threadId: "t-room-mixed-2" }] },
  { id: "room-empty", threadId: "t-room-empty", memberIds: ["gone"] },
];

describe("visibility values", () => {
  it("reads an admin's input and fails closed on anything it cannot read", () => {
    expect(parseVisibility("everyone")).toEqual({ ok: true, visibility: "everyone" });
    expect(parseVisibility(null)).toEqual({ ok: true, visibility: "everyone" });
    expect(parseVisibility(undefined).ok).toBe(false);
    expect(parseVisibility("admins")).toEqual({ ok: true, visibility: "admins" });
    expect(parseVisibility({ people: [" Ada@Example.test ", "ada@example.test", "@corp.test", ""] }))
      .toEqual({ ok: true, visibility: { people: ["ada@example.test", "@corp.test"] } });
    // a list that names nobody is admins only, never everyone
    expect(parseVisibility({ people: [] })).toEqual({ ok: true, visibility: "admins" });
    expect(parseVisibility({ people: ["not an email"] }).ok).toBe(false);
    expect(parseVisibility({ people: ["a@b.c"], extra: 1 }).ok).toBe(false);
    expect(parseVisibility("members").ok).toBe(false);
    expect(parseVisibility({ people: Array.from({ length: 501 }, (_, i) => `p${i}@x.test`) }).ok).toBe(false);

    expect(storedVisibility(undefined)).toBe("everyone");
    expect(storedVisibility("garbage")).toBe("admins");
    expect(storedVisibility({ people: "ada@example.test" })).toBe("admins");
  });

  it("lets admins and the owner see everything, and members only what names them", () => {
    expect(viewerSees(SEES_EVERYTHING, "admins")).toBe(true);
    expect(viewerSees(ADA, undefined)).toBe(true);
    expect(viewerSees(ADA, "admins")).toBe(false);
    expect(viewerSees(ADA, { people: ["ada@example.test"] })).toBe(true);
    expect(viewerSees({ kind: "member", email: "ADA@example.test" }, { people: ["ada@example.test"] })).toBe(true);
    expect(viewerSees(BOB, { people: ["ada@example.test"] })).toBe(false);
    expect(viewerSees(BOB, { people: ["@example.test"] })).toBe(true);
    expect(viewerSees({ kind: "member", email: "eve@evilexample.test" }, { people: ["@example.test"] })).toBe(false);
    // a paired device with no email is only ever shown bots everyone sees
    expect(viewerSees(NOBODY, { people: ["@example.test"] })).toBe(false);
    expect(viewerSees(NOBODY, undefined)).toBe(true);
  });

  it("knows when one audience sits inside another", () => {
    expect(audienceWithin({ people: ["ada@example.test"] }, undefined)).toBe(true);
    expect(audienceWithin(undefined, { people: ["ada@example.test"] })).toBe(false);
    expect(audienceWithin("admins", { people: ["ada@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["ada@example.test"] }, "admins")).toBe(false);
    expect(audienceWithin({ people: ["ada@example.test"] }, { people: ["ada@example.test", "bob@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["ada@example.test", "bob@example.test"] }, { people: ["ada@example.test"] })).toBe(false);
    expect(audienceWithin({ people: ["ada@example.test"] }, { people: ["@example.test"] })).toBe(true);
    expect(audienceWithin({ people: ["@example.test"] }, { people: ["ada@example.test"] })).toBe(false);
    // a room feeds a bot only when everyone who sees the bot sees every bot in it
    expect(roomFeeds([undefined, { people: ["ada@example.test"] }], undefined)).toBe(false);
    expect(roomFeeds([undefined, { people: ["ada@example.test"] }], { people: ["ada@example.test"] })).toBe(true);
    expect(roomFeeds([undefined, undefined], undefined)).toBe(true);
  });

  it("finds the people two audiences share", () => {
    expect(intersectAudience(undefined, "admins")).toBe("admins");
    expect(intersectAudience(undefined, undefined)).toBe("everyone");
    expect(intersectAudience({ people: ["ada@example.test"] }, undefined)).toEqual({ people: ["ada@example.test"] });
    expect(intersectAudience({ people: ["ada@example.test", "bob@example.test"] }, { people: ["bob@example.test", "cy@example.test"] })).toEqual({ people: ["bob@example.test"] });
    expect(intersectAudience({ people: ["@example.test"] }, { people: ["ada@example.test", "eve@other.test"] })).toEqual({ people: ["ada@example.test"] });
    expect(intersectAudience({ people: ["ada@example.test"] }, { people: ["bob@example.test"] })).toBe("admins");
    expect(narrowestAudience([undefined, { people: ["ada@example.test", "bob@example.test"] }, { people: ["ada@example.test"] }])).toEqual({ people: ["ada@example.test"] });
  });

  it("keeps a room at its floor after the bot that set it is gone", () => {
    const open = bots.map(({ visibility: _v, ...bot }) => bot);
    const floored = [{ id: "room-old", threadId: "t-room-old", memberIds: ["pub"], audienceFloor: { people: ["ada@example.test"] } }];
    const bob = new VisibleSet(open, floored, BOB);
    expect(bob.everything).toBe(false);
    expect([bob.group("room-old"), bob.thread("t-room-old"), bob.bot("pub")]).toEqual([false, false, true]);
    expect(new VisibleSet(open, floored, ADA).group("room-old")).toBe(true);
    expect(roomFeeds([undefined, floored[0]!.audienceFloor], undefined)).toBe(false);
  });

  it("compares audiences exactly", () => {
    expect(sameAudience(undefined, "everyone")).toBe(true);
    expect(sameAudience(undefined, "admins")).toBe(false);
    expect(sameAudience({ people: ["a@x.test", "b@x.test"] }, { people: ["b@x.test", "a@x.test"] })).toBe(true);
    expect(sameAudience({ people: ["a@x.test"] }, { people: ["a@x.test", "b@x.test"] })).toBe(false);
    expect(sameAudience({ people: ["a@x.test"] }, "admins")).toBe(false);
  });
});

describe("VisibleSet", () => {
  it("filters nothing when no bot is restricted, or for someone who sees everything", () => {
    const open = new VisibleSet(bots.map(({ visibility: _v, ...bot }) => bot), groups, BOB);
    expect(open.everything).toBe(true);
    expect(open.bot("anything")).toBe(true);
    const admin = new VisibleSet(bots, groups, SEES_EVERYTHING);
    expect(admin.everything).toBe(true);
    expect(admin.thread("t-hr")).toBe(true);
  });

  it("answers bots, rooms, threads and sections for a member", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    expect(bob.everything).toBe(false);
    expect([bob.bot("pub"), bob.bot("hr"), bob.bot("adm"), bob.bot("corp"), bob.bot("unknown")]).toEqual([true, false, false, true, false]);
    // a room needs every one of its bots visible
    expect([bob.group("room-pub"), bob.group("room-mixed"), bob.group("room-empty")]).toEqual([true, false, false]);
    expect([bob.thread("t-pub-2"), bob.thread("t-hr"), bob.thread("t-room-mixed-2"), bob.thread("t-unknown")]).toEqual([true, false, false, false]);
    expect(bob.sections(["Ops", "People", "Empty"])).toEqual(["Ops"]);

    const ada = new VisibleSet(bots, groups, ADA);
    expect([ada.bot("hr"), ada.bot("adm"), ada.group("room-mixed"), ada.thread("t-room-mixed-2")]).toEqual([true, false, true, true]);
    expect(ada.sections(["Ops", "People"])).toEqual(["Ops", "People"]);
  });

  it("refuses an attachment only when everything that uses it is hidden", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const refs: Record<string, string[]> = { "in-hr.png": ["t-hr"], "shared.png": ["t-hr", "t-pub"], "fresh.png": [] };
    const lookup = (name: string) => refs[name] ?? [];
    expect(bob.attachment("hr.png", lookup)).toBe(false); // the restricted bot's avatar
    expect(bob.attachment("in-hr.png", lookup)).toBe(false);
    expect(bob.attachment("shared.png", lookup)).toBe(true);
    expect(bob.attachment("fresh.png", lookup)).toBe(true);
    expect(new VisibleSet(bots, groups, ADA).attachment("in-hr.png", lookup)).toBe(true);
  });

  it("routes each path to the entity it names", () => {
    expect(pathSubject("/api/bots/hr/messages")).toEqual({ kind: "bot", id: "hr" });
    expect(pathSubject("/api/bots/hr")).toEqual({ kind: "bot", id: "hr" });
    expect(pathSubject("/api/threads/t-hr/export")).toEqual({ kind: "thread", id: "t-hr" });
    expect(pathSubject("/api/groups/room-mixed/read")).toEqual({ kind: "group", id: "room-mixed" });
    expect(pathSubject("/api/routines/r1/run")).toEqual({ kind: "routine", id: "r1" });
    expect(pathSubject("/api/routines/wake")).toBeNull();
    expect(pathSubject("/api/routine-runs/run1/seen")).toEqual({ kind: "routine-run", id: "run1" });
    expect(pathSubject("/api/routine-runs/seen-all")).toBeNull();
    expect(pathSubject("/api/attachments/a.png")).toEqual({ kind: "attachment", name: "a.png" });
    expect(pathSubject("/api/attachments")).toBeNull();
    expect(pathSubject("/api/bots")).toBeNull();
    expect(pathSubject("/api/groups")).toBeNull();
  });

  it("follows a routine to its room when it runs in one", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    expect(routineVisible({ botId: "pub" }, bob)).toBe(true);
    expect(routineVisible({ botId: "hr" }, bob)).toBe(false);
    expect(routineVisible({ botId: "pub", groupId: "room-mixed" }, bob)).toBe(false);
  });
});

describe("live frames for a member", () => {
  const context = (visible: VisibleSet): FrameContext => ({
    visible,
    webhookBot: (id) => ({ "hook-hr": "hr", "hook-pub": "pub" } as Record<string, string>)[id],
    freshBot: (id) => ({ id, messages: [{ id: "m1" }] }),
    freshGroup: (id) => ({ id, messages: [] }),
  });
  const seen = (): StreamSeen => ({ bots: new Set(["pub", "corp"]), groups: new Set(["room-pub"]) });

  it("drops every frame about a hidden bot, thread or room", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const ctx = context(bob);
    const hidden: Array<Record<string, unknown>> = [
      { kind: "message", threadId: "t-hr", message: { id: "x" } },
      { kind: "message.patch", threadId: "t-room-mixed", message: { id: "x" } },
      { kind: "thread", threadId: "t-hr", activeLeafId: "x" },
      { kind: "bot", bot: { id: "hr" } },
      { kind: "group", group: { id: "room-mixed" } },
      { kind: "bot.deleted", botId: "hr" },
      { kind: "group.deleted", groupId: "room-mixed" },
      { kind: "notify", notification: { botId: "hr", threadId: "t-hr" } },
      { kind: "runtime", event: { type: "content.delta", threadId: "t-hr" } },
      { kind: "screen", botId: "hr", threadId: "t-hr", png: "…" },
      { kind: "computer", botId: "adm", state: "waking" },
      { kind: "computer-control", botId: "adm", held: true },
      { kind: "routine", routine: { id: "r", botId: "hr" } },
      { kind: "routine.run", run: { id: "r", botId: "pub", groupId: "room-mixed" } },
      { kind: "webhook", webhook: { id: "hook-hr", botId: "hr" } },
      { kind: "webhook.attempt", attempt: { webhookId: "hook-hr" } },
      { kind: "future-kind", threadId: "t-hr" },
    ];
    for (const frame of hidden) expect(frameForMember(frame, ctx, seen()), JSON.stringify(frame)).toBeUndefined();
  });

  it("passes visible frames through untouched and narrows the lists", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const ctx = context(bob);
    const message = { kind: "message", threadId: "t-pub-2", message: { id: "x" } };
    expect(frameForMember(message, ctx, seen())).toBe(message);
    const hook = { kind: "webhook.attempt", attempt: { webhookId: "hook-pub" } };
    expect(frameForMember(hook, ctx, seen())).toBe(hook);
    expect(frameForMember({ kind: "sections", sections: ["Ops", "People"] }, ctx, seen())).toEqual({ kind: "sections", sections: ["Ops"] });
    expect(frameForMember({ kind: "bot.queued", queues: { "t-pub": [1], "t-hr": [2] } }, ctx, seen())).toEqual({ kind: "bot.queued", queues: { "t-pub": [1] } });
    const config = { kind: "config", membership: {} };
    expect(frameForMember(config, ctx, seen())).toBe(config);
    // a member's copy of a bot never lists who else may see it, nor a teammate they cannot
    expect(frameForMember({ kind: "bot", bot: { id: "corp", visibility: { people: ["@example.test"] }, peers: ["pub", "hr"] } }, ctx, seen()))
      .toEqual({ kind: "bot", bot: { id: "corp", peers: ["pub"] } });
  });

  it("withdraws a bot once when it becomes hidden, and sends it whole when it appears", () => {
    const state = seen();
    const before = new VisibleSet(bots, groups, BOB);
    // Bob was shown "pub"; now an admin restricts it to Ada.
    const restricted = bots.map((bot) => (bot.id === "pub" ? { ...bot, visibility: { people: ["ada@example.test"] } } : bot));
    const after = new VisibleSet(restricted, groups, BOB);
    expect(frameForMember({ kind: "bot", bot: { id: "pub" } }, context(after), state)).toEqual({ kind: "bot.deleted", botId: "pub" });
    expect(frameForMember({ kind: "bot", bot: { id: "pub" } }, context(after), state)).toBeUndefined();
    // and gives it back: the whole record, transcript page included
    expect(frameForMember({ kind: "bot", bot: { id: "pub", name: "Pub" } }, context(before), state))
      .toEqual({ kind: "bot", bot: { id: "pub", name: "Pub", messages: [{ id: "m1" }] } });
    expect(state.bots.has("pub")).toBe(true);
    // the same for a room
    const roomState = seen();
    const hiddenRoom = new VisibleSet(restricted, groups, BOB);
    expect(frameForMember({ kind: "group", group: { id: "room-pub" } }, context(hiddenRoom), roomState)).toEqual({ kind: "group.deleted", groupId: "room-pub" });
  });

  it("keeps a stream's record current while nothing is restricted", () => {
    const state: StreamSeen = { bots: new Set(), groups: new Set() };
    noteSeen({ kind: "bot", bot: { id: "new" } }, state);
    noteSeen({ kind: "group", group: { id: "room" } }, state);
    expect([...state.bots, ...state.groups]).toEqual(["new", "room"]);
    noteSeen({ kind: "bot.deleted", botId: "new" }, state);
    expect(state.bots.size).toBe(0);
  });

  it("narrows every bot in a JSON answer for a member", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    const body = {
      bot: { id: "corp", visibility: { people: ["@example.test"] }, peers: ["pub", "hr"] },
      bots: [{ id: "pub", visibility: "everyone" }],
      result: { bot: { id: "corp", visibility: "admins" } },
      messages: [{ bot: { visibility: "untouched" } }],
      ok: true,
    };
    expect(memberBody(body, bob)).toEqual({
      bot: { id: "corp", peers: ["pub"] },
      bots: [{ id: "pub" }],
      result: { bot: { id: "corp" } },
      messages: [{ bot: { visibility: "untouched" } }],
      ok: true,
    });
    const admin = new VisibleSet(bots, groups, SEES_EVERYTHING);
    expect(memberBody(body, admin)).toBe(body);
  });

  it("strips nothing for someone who sees everything", () => {
    const bot = { id: "hr", visibility: "admins", peers: ["x"] };
    expect(memberBot(bot, new VisibleSet(bots, groups, SEES_EVERYTHING))).toBe(bot);
  });
});
