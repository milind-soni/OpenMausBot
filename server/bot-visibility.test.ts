import { describe, expect, it } from "vitest";

import {
  audienceWithin,
  intersectAudience,
  narrowestAudience,
  frameForMember,
  memberBody,
  memberBot,
  memberFramePayload,
  noteSeen,
  parseVisibility,
  bodyThreadIds,
  pathSubject,
  requestThreadIds,
  roomFeeds,
  routineRunVisible,
  routineVisible,
  sameAudience,
  webhookVisible,
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
/** A Team Cloud's admin: every bot, and only their own private chats (audience.ts). */
const BEN_ADMIN: Viewer = { kind: "all", email: "ben@example.test" };

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

  it("shows a room webhook only to someone who sees both its bot and its room", () => {
    const bob = new VisibleSet(bots, groups, BOB);
    expect(webhookVisible({ botId: "pub" }, bob)).toBe(true);
    expect(webhookVisible({ botId: "pub", groupId: "room-pub" }, bob)).toBe(true);
    expect(webhookVisible({ botId: "pub", groupId: "room-mixed" }, bob)).toBe(false);
    expect(webhookVisible({ botId: "hr", groupId: "room-pub" }, bob)).toBe(false);
    expect(webhookVisible({ botId: "hr", groupId: "room-mixed" }, new VisibleSet(bots, groups, SEES_EVERYTHING))).toBe(true);
  });
});

describe("live frames for a member", () => {
  const context = (visible: VisibleSet): FrameContext => ({
    visible,
    webhook: (id) => ({ "hook-hr": { botId: "hr" }, "hook-pub": { botId: "pub" }, "hook-room-mixed": { botId: "pub", groupId: "room-mixed" } } as Record<string, { botId: string; groupId?: string }>)[id],
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
      { kind: "webhook", webhook: { id: "hook-room-mixed", botId: "pub", groupId: "room-mixed" } },
      { kind: "webhook.attempt", attempt: { webhookId: "hook-room-mixed" } },
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
    expect(frameForMember({ kind: "bots.order", botIds: ["hr", "pub", "corp"] }, ctx, seen())).toEqual({ kind: "bots.order", botIds: ["pub", "corp"] });
    const config = { kind: "config", membership: {} };
    expect(frameForMember(config, ctx, seen())).toBe(config);
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
    expect(frameForMember({ kind: "bot", bot: { id: "pub", name: "Pub" } }, context(before), state))
      .toEqual({ kind: "bot", bot: { id: "pub", name: "Pub", messages: [{ id: "m1" }] } });
    expect(state.bots.has("pub")).toBe(true);
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

  it("keeps a bot's own server alias from every member, whether or not they can see every bot", () => {
    const open = new VisibleSet(bots.map(({ visibility: _v, ...bot }) => bot), [{ ...groups[0]!, audienceFloor: "everyone" }], BOB);
    const narrowed = new VisibleSet(bots, groups, ADA);
    expect(open.everything).toBe(true);
    expect(narrowed.everything).toBe(false);
    const bot = { id: "pub", cloudBackend: "vps", vpsAlias: "alpha-vps" };
    expect(memberBot(bot, open)).toEqual({ id: "pub", cloudBackend: "vps" });
    expect(memberBot(bot, narrowed)).toEqual({ id: "pub", cloudBackend: "vps" });
    // The owner and admins share the same everything-visible path and keep it.
    const admin = new VisibleSet(bots, groups, SEES_EVERYTHING);
    expect(memberBot(bot, admin)).toBe(bot);
    expect(memberBody({ bots: [bot] }, admin)).toEqual({ bots: [bot] });

    const room = { id: "room-pub", audienceFloor: "everyone" };
    const body = { bots: [bot, { id: "hr" }], group: room, result: { bot } };
    const shown = memberBody(body, open) as typeof body;
    expect(JSON.stringify(shown)).not.toContain("alpha-vps");
    expect(shown.bots[1]).toBe(body.bots[1]);
    // A member who sees every room gets it as it is; only a narrowed member loses the audience floor.
    expect(shown.group).toBe(room);
    expect((memberBody(body, narrowed) as typeof body).group).toEqual({ id: "room-pub" });

    // The live frame every member shares, and an untouched frame kept as the same object for the shared bytes.
    expect(memberFramePayload({ kind: "bot", bot })).toEqual({ kind: "bot", bot: { id: "pub", cloudBackend: "vps" } });
    const plain = { kind: "bot", bot: { id: "pub" } };
    expect(memberFramePayload(plain)).toBe(plain);
    const config = { kind: "config", vpsAlias: "not a bot" };
    expect(memberFramePayload(config)).toBe(config);
  });
});

describe("a Team Cloud's audiences", () => {
  const ADA_KEY = "p_adaadaadaadaadaadaada1", BEN_KEY = "p_benbenbenbenbenbenben1";
  const audienceOf = (threadId: string) =>
    threadId === "t-pub-2" ? `member:${ADA_KEY}` as const : threadId === "t-pub" ? "team" as const : threadId.startsWith("t-room") ? "room:room-pub" as const : undefined;
  const open = bots.map(({ visibility: _v, ...bot }) => bot);
  const openGroups = [{ id: "room-pub", threadId: "t-room-pub", memberIds: ["pub"], tasks: [{ threadId: "t-room-pub-2" }] }];

  it("a member sees the team's conversations, the rooms they see and their own; never another member's", () => {
    const ada = new VisibleSet(open, openGroups, ADA, undefined, { of: audienceOf, person: ADA_KEY });
    expect(ada.everything).toBe(false);
    expect(ada.filtersThreads).toBe(true);
    expect([ada.thread("t-pub"), ada.thread("t-pub-2"), ada.thread("t-room-pub"), ada.thread("t-room-pub-2")]).toEqual([true, true, true, true]);
    const ben = new VisibleSet(open, openGroups, BOB, undefined, { of: audienceOf, person: BEN_KEY });
    expect([ben.thread("t-pub"), ben.thread("t-pub-2"), ben.thread("t-room-pub")]).toEqual([true, false, true]);
    expect(ben.bot("pub")).toBe(true);
    const nobody = new VisibleSet(open, openGroups, NOBODY, undefined, { of: audienceOf, person: null });
    expect(nobody.thread("t-pub-2")).toBe(false);
    // The server itself (no person, no audiences) sees everything.
    expect(new VisibleSet(open, openGroups, SEES_EVERYTHING).thread("t-pub-2")).toBe(true);
    // Without audiences (a My Cloud, a desktop) nothing changes: an open workspace is everything to a member.
    expect(new VisibleSet(open, openGroups, BOB).everything).toBe(true);
  });

  it("an admin, the Owner too, sees every bot and room and the team's conversations, but only their own private chat", () => {
    const audiences = (threadId: string) => threadId === "t-pub-3" ? `member:${BEN_KEY}` as const : audienceOf(threadId);
    const withBens = [{ ...open[0]!, tasks: [...open[0]!.tasks!, { threadId: "t-pub-3" }] }, ...open.slice(1)];
    const admin = new VisibleSet(withBens, openGroups, BEN_ADMIN, undefined, { of: audiences, person: BEN_KEY });
    expect(admin.everything).toBe(false);
    expect(admin.filtersThreads).toBe(true);
    expect(admin.member).toBe(false);
    expect([admin.thread("t-pub"), admin.thread("t-pub-3"), admin.thread("t-room-pub"), admin.thread("t-room-pub-2")]).toEqual([true, true, true, true]);
    expect(admin.thread("t-pub-2")).toBe(false);
    expect(admin.hides("t-pub-2")).toBe(true);
    expect(admin.hides("t-pub")).toBe(false);
    // Every bot (a restricted one too), every room and every section stay an admin's.
    expect(withBens.every((bot) => admin.bot(bot.id))).toBe(true);
    expect(admin.group("room-pub")).toBe(true);
    expect(admin.sections(["Ops", "People", "Empty"])).toEqual(["Ops", "People", "Empty"]);
    // A deleted private chat stays its person's: what still names it (a usage row) is never an admin's.
    const gone = new VisibleSet(withBens, openGroups, BEN_ADMIN, (threadId) => (threadId === "t-pub-2" ? undefined : { bot: "pub" }), { of: audiences, person: BEN_KEY });
    expect(gone.thread("t-pub-2")).toBe(false);
    expect(gone.hides("t-pub-2")).toBe(true);
    // An unknown conversation with no audience is as before: the route answers it.
    expect(admin.thread("t-unknown")).toBe(true);
    expect(admin.hides("t-unknown")).toBe(false);
  });

  it("a bot sent to an admin keeps its setup but loses another person's chats, their messages and their unread mark", () => {
    const admin = new VisibleSet(open, openGroups, BEN_ADMIN, undefined, { of: audienceOf, person: BEN_KEY });
    const bot = { id: "pub", threadId: "t-pub-2", mainThreadId: "t-pub", visibility: "everyone", vpsAlias: "box", unread: true,
      messages: [{ text: "Kumquat" }], hasMore: true, pinnedMessageId: "m1", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2", unread: true }] };
    const sent = memberBot(bot, admin) as Record<string, unknown>;
    expect(sent).toEqual({ id: "pub", threadId: "t-pub", mainThreadId: "t-pub", visibility: "everyone", vpsAlias: "box", unread: false, tasks: [{ threadId: "t-pub" }] });
    expect(JSON.stringify(memberBody({ bots: [bot], bot }, admin))).not.toContain("Kumquat");
    // A room keeps its audience floor for an admin.
    const room = { id: "room-pub", audienceFloor: "admins" };
    expect((memberBody({ group: room }, admin) as { group: unknown }).group).toBe(room);
    // The selected chat with no main chat to name instead: the field goes, never the hidden id.
    expect(memberBot({ id: "pub", threadId: "t-pub-2" }, admin)).toEqual({ id: "pub" });
  });

  it("a live frame from another person's private chat never reaches an admin's stream", () => {
    const admin = new VisibleSet(open, openGroups, BEN_ADMIN, undefined, { of: audienceOf, person: BEN_KEY });
    const ctx: FrameContext = { visible: admin, webhook: () => undefined, freshBot: () => undefined, freshGroup: () => undefined };
    const seen: StreamSeen = { bots: new Set(open.map((bot) => bot.id)), groups: new Set(["room-pub"]) };
    for (const frame of [
      { kind: "message", threadId: "t-pub-2", message: { text: "Kumquat" } },
      { kind: "message.patch", threadId: "t-pub-2", message: { text: "Kumquat" } },
      { kind: "notify", notification: { threadId: "t-pub-2", botId: "pub", body: "Kumquat" } },
      { kind: "runtime", event: { threadId: "t-pub-2" } },
      { kind: "screen", botId: "pub", threadId: "t-pub-2" },
      { kind: "notifications.read", threadId: "t-pub-2", ids: ["n1"] },
      { kind: "routine.run", run: { botId: "pub", threadId: "t-pub-2", output: "Kumquat" } },
    ]) expect(frameForMember(frame, ctx, seen), frame.kind).toBeUndefined();
    expect(frameForMember({ kind: "message", threadId: "t-pub", message: {} }, ctx, seen)).toBeDefined();
    const queued = frameForMember({ kind: "bot.queued", queues: { "t-pub": [1], "t-pub-2": [2] } }, ctx, seen);
    expect(queued).toEqual({ kind: "bot.queued", queues: { "t-pub": [1] } });
    const bot = frameForMember({ kind: "bot", bot: { id: "pub", threadId: "t-pub", visibility: "everyone", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2" }] } }, ctx, seen);
    expect(bot).toEqual({ kind: "bot", bot: { id: "pub", threadId: "t-pub", visibility: "everyone", tasks: [{ threadId: "t-pub" }] } });
    const group = { kind: "group", group: { id: "room-pub", audienceFloor: "admins" } };
    expect(frameForMember(group, ctx, seen)).toBe(group);
    // A plea for a hand from Ada's chat: the computer is held, nothing more.
    expect(frameForMember({ kind: "computer-control", botId: "pub", held: true, helpReason: "Sign in to the bank", help: { botId: "pub", threadId: "t-pub-2", site: "bank.test" } }, ctx, seen))
      .toEqual({ kind: "computer-control", botId: "pub", held: true, helpReason: null });
    const teams = { kind: "computer-control", botId: "pub", held: true, helpReason: "Sign in", help: { botId: "pub", threadId: "t-pub", site: "x.test" } };
    expect(frameForMember(teams, ctx, seen)).toBe(teams);
    expect(routineRunVisible({ botId: "pub", threadId: "t-pub-2" }, admin)).toBe(false);
    expect(routineRunVisible({ botId: "pub", threadId: "t-pub", resultsThreadId: "t-pub-2" }, admin)).toBe(false);
    expect(routineRunVisible({ botId: "pub", threadId: "t-pub" }, admin)).toBe(true);
  });

  it("finds every conversation a request names: a task in the path, the query and the body", () => {
    expect(requestThreadIds("/api/bots/pub/tasks/t-pub-2", new URLSearchParams())).toEqual(["t-pub-2"]);
    expect(requestThreadIds("/api/bots/pub/tasks/t-pub-2/title", new URLSearchParams("threadId=t-x"))).toEqual(["t-pub-2", "t-x"]);
    expect(requestThreadIds("/api/groups/g/tasks/t-g", new URLSearchParams())).toEqual(["t-g"]);
    expect(requestThreadIds("/api/bots/pub/browser/live", new URLSearchParams("threadId=t-pub-2"))).toEqual(["t-pub-2"]);
    expect(requestThreadIds("/api/bots/pub", new URLSearchParams())).toEqual([]);
    expect(bodyThreadIds({ threadId: "a", resultsThreadId: "b", threadIds: ["c", 1], envelope: { threadId: "d" }, text: "threadId" })).toEqual(["a", "b", "c", "d"]);
    expect(bodyThreadIds({ deep: { deeper: { threadId: "x" } } })).toEqual([]);
    expect(bodyThreadIds([{ threadId: "x" }])).toEqual([]);
    expect(bodyThreadIds(null)).toEqual([]);
  });

  it("a bot sent to a member lists only the conversations that member may see", () => {
    const ben = new VisibleSet(open, openGroups, BOB, undefined, { of: audienceOf, person: BEN_KEY });
    const sent = memberBot({ id: "pub", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2" }], vpsAlias: "x" }, ben);
    expect(sent).toEqual({ id: "pub", tasks: [{ threadId: "t-pub" }] });
    const ada = new VisibleSet(open, openGroups, ADA, undefined, { of: audienceOf, person: ADA_KEY });
    expect(memberBot({ id: "pub", tasks: [{ threadId: "t-pub" }, { threadId: "t-pub-2" }] }, ada).tasks).toHaveLength(2);
    // Off a team the list is untouched.
    expect(memberBot({ id: "pub", tasks: [{ threadId: "t-pub-2" }] }, new VisibleSet(bots, groups, BOB)).tasks).toEqual([{ threadId: "t-pub-2" }]);
  });
});
