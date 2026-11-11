import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ calls: [] as Array<[string, RequestInit | undefined]>, answer: null as unknown }));
vi.mock("./api", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push([path, init]);
    return server.answer;
  }),
}));

import { openBot } from "./thread-navigation";
import { rememberOwnChat, setTeamChats, type TeamChats } from "./team-chats";
import { botOnSide, listedSide, savedTeamSide, setTeamSide, sharedWithOthers, showTeamSide, sideOfThread, tasksOfSide, teamSide, teamSideView, teamThreadOf, teamThreadToOpen } from "./team-side";

const ADA: TeamChats = { teamId: "team-acme", member: true, opened: [], person: "ada@acme.test" };
const BEN: TeamChats = { ...ADA, person: "ben@acme.test" };

const MAIN = { threadId: "scout-main", title: "Shared chat", createdAt: 1, sharedChat: true as const };
type Extra = Record<string, unknown>;
type TestTask = { threadId: string; private?: unknown; sharedChat?: unknown; unread?: boolean };
type TestBot = { id: string; threadId: string; mainThreadId: string; tasks: TestTask[]; messages: unknown[]; yourAccess?: string; hidden?: boolean; defaultBot?: { person: string } };
const scout = (tasks: Extra[] = [], extra: Extra = {}) =>
  ({ id: "scout", threadId: "scout-main", mainThreadId: "scout-main", tasks: [MAIN, ...tasks], messages: [{ id: "m1" }], ...extra }) as unknown as TestBot;
const mausbot = (extra: Extra = {}) =>
  ({ id: "mine", threadId: "mine-main", mainThreadId: "mine-main", defaultBot: { person: "ada@acme.test" }, tasks: [{ threadId: "mine-main", createdAt: 1 }, { threadId: "mine-2", createdAt: 2 }], messages: [], ...extra }) as unknown as TestBot;
const room = (extra: Extra = {}) => ({ id: "room-1", unread: false, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ids = (list: Array<{ id: string }>) => list.map((item) => item.id);

const stored = new Map<string, string>();
const localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
beforeEach(() => { vi.stubGlobal("localStorage", localStorage); stored.clear(); server.calls.length = 0; server.answer = null; });
afterEach(() => { setTeamChats(null); vi.unstubAllGlobals(); });

describe("the side of a conversation is the server's answer", () => {
  it("is Just me only for a conversation the server marked private, one this page made through the private route, or the person's own MausBot", () => {
    setTeamChats(ADA);
    const bot = scout([{ threadId: "ada-own", private: true, createdAt: 2 }, { threadId: "report", createdAt: 3 }]);
    expect(sideOfThread(bot, "ada-own")).toBe("me");
    expect(sideOfThread(bot, "scout-main")).toBe("team");
    expect(sideOfThread(bot, "report"), "a shared report").toBe("team");
    expect(sideOfThread(bot, "never-heard-of"), "unknown is never called private").toBe("team");
    rememberOwnChat("team-acme", "just-made");
    expect(sideOfThread(bot, "just-made"), "made a moment ago, its task not here yet").toBe("me");
    expect(sideOfThread(mausbot(), "mine-main"), "nobody else is ever sent it").toBe("me");
  });

  it("never calls the shared chat Just me, even if the session lists it among the conversations this person opened", () => {
    setTeamChats({ ...ADA, opened: ["scout-main"] });
    expect(sideOfThread(scout(), "scout-main")).toBe("team");
    expect(teamThreadOf({ tasks: [{ threadId: "t1", sharedChat: true, private: true }] }), "a private chat is never the team thread").toBeNull();
    expect(teamThreadOf(mausbot()), "a person's own MausBot has none").toBeNull();
  });

  it("does not move with the switch: the same conversation is the same side whichever side the sidebar shows", () => {
    setTeamChats(ADA);
    const bot = scout([{ threadId: "ada-own", private: true, createdAt: 2 }]);
    for (const shown of ["me", "team"] as const) {
      setTeamSide(shown);
      expect(sideOfThread(bot, "ada-own")).toBe("me");
      expect(sideOfThread(bot, "scout-main")).toBe("team");
    }
  });

  it("holds for every mix of conversations: Just me is exactly the private ones, Team exactly the rest", () => {
    setTeamChats(ADA);
    const kinds = [
      { private: true }, { private: true, routineRunId: "r1" }, { private: true, openedBy: { botId: "x" } }, { private: true, archivedAt: 5 },
      {}, { routineRunId: "r2" }, { openedBy: { botId: "x" } }, { private: false }, { private: "yes" }, { private: 1 },
    ];
    const tasks = kinds.map((kind, index) => ({ threadId: `t${index}`, createdAt: index, ...kind }));
    const bot = scout(tasks);
    const me = tasksOfSide(bot, "me"), team = tasksOfSide(bot, "team");
    expect(me.length).toBe(4);
    expect(me.every((task) => task.private === true), "no shared conversation under Just me").toBe(true);
    expect(team.some((task) => task.private === true), "no private conversation under Team").toBe(false);
    expect(me.length + team.length).toBe(tasks.length + 1);
  });
});

describe("what each side of the sidebar lists", () => {
  it("lists everything, untouched, off a team", () => {
    const bots = [scout()], groups = [room()];
    const view = teamSideView(bots, groups, null, "team");
    expect(view.switchable).toBe(false);
    expect(view.bots).toBe(bots);
    expect(view.groups).toBe(groups);
  });

  it("lists under Just me the bots the person can chat with privately, with their private chats only, and no group chat", () => {
    const view = teamSideView([scout([{ threadId: "ada-own", private: true, createdAt: 2 }]), mausbot()], [room()], ADA, "me");
    expect(view.switchable).toBe(true);
    expect(ids(view.bots)).toEqual(["scout", "mine"]);
    expect(view.bots[0]!.tasks.map((task) => task.threadId)).toEqual(["ada-own"]);
    expect(view.bots[1]!.tasks.length, "their own MausBot keeps all its chats").toBe(2);
    expect(view.groups).toEqual([]);
  });

  it("lists under Team the bots with a shared chat, with no private chat among their conversations, and the group chats", () => {
    const view = teamSideView([scout([{ threadId: "ada-own", private: true, createdAt: 2 }, { threadId: "report", createdAt: 3 }]), mausbot()], [room()], ADA, "team");
    expect(ids(view.bots), "a private-only bot is under Just me only").toEqual(["scout"]);
    expect(view.bots[0]!.tasks.map((task) => task.threadId)).toEqual(["scout-main", "report"]);
    expect(ids(view.groups)).toEqual(["room-1"]);
  });

  it("shows nothing of a private chat in the Team list, and nothing of a shared one under Just me: not even the preview of the one on screen", () => {
    const privateOnScreen = scout([{ threadId: "ada-own", private: true, createdAt: 2 }], { threadId: "ada-own", messages: [{ id: "secret" }] });
    expect(teamSideView([privateOnScreen, mausbot()], [], ADA, "team").bots[0]!.messages).toEqual([]);
    expect(teamSideView([privateOnScreen, mausbot()], [], ADA, "me").bots[0]!.messages).toEqual([{ id: "secret" }]);
    const sharedOnScreen = scout([{ threadId: "ada-own", private: true, createdAt: 2 }]);
    expect(teamSideView([sharedOnScreen, mausbot()], [], ADA, "me").bots[0]!.messages).toEqual([]);
  });

  it("lists a bot the person can only view under Team alone, unless they have a conversation of their own with it", () => {
    expect(botOnSide(scout([], { yourAccess: "view" }), ADA, "me")).toBe(false);
    expect(botOnSide(scout([], { yourAccess: "view" }), ADA, "team")).toBe(true);
    expect(botOnSide(scout([{ threadId: "ada-old", private: true, createdAt: 2 }], { yourAccess: "view" }), ADA, "me")).toBe(true);
  });

  it("knows a bot is shared from what this copy of it says: its sharing for someone who can edit it, having it at all for anyone else", () => {
    const owner = { createdBy: "ada@acme.test", yourAccess: "edit" };
    expect(sharedWithOthers({ ...owner, access: { everyone: "none", people: {} } }), "only its owner and the admins").toBe(false);
    expect(sharedWithOthers({ ...owner, access: { everyone: "none", people: { "ada@acme.test": "edit" } } }), "the owner's own entry is nobody else").toBe(false);
    expect(sharedWithOthers({ ...owner, access: { everyone: "none", people: { "ben@acme.test": "view" } } })).toBe(true);
    expect(sharedWithOthers({ ...owner, access: { everyone: "chat", people: {} } })).toBe(true);
    expect(sharedWithOthers({ ...owner, visibility: "admins" }), "set up before levels, admins only").toBe(false);
    expect(sharedWithOthers({ ...owner, visibility: { people: ["ada@acme.test"] } })).toBe(false);
    expect(sharedWithOthers({ ...owner }), "set up before levels, everyone").toBe(true);
    for (const yourAccess of ["view", "chat"]) expect(sharedWithOthers({ createdBy: "ada@acme.test", yourAccess }), "it was shared with this person").toBe(true);
    expect(sharedWithOthers({ defaultBot: { person: "ada@acme.test" }, yourAccess: "edit" })).toBe(false);
  });

  it("lists a bot nobody else can use under Just me only, its main chat with it, and never under Team", () => {
    const mine = scout([{ threadId: "ada-own", private: true, createdAt: 2 }], { createdBy: "ada@acme.test", yourAccess: "edit", access: { everyone: "none", people: {} } });
    const shared = { ...scout([], { yourAccess: "chat" }), id: "payroll", threadId: "payroll-main", mainThreadId: "payroll-main", tasks: [{ ...MAIN, threadId: "payroll-main" }] };
    expect(botOnSide(mine, ADA, "team")).toBe(false);
    expect(botOnSide(mine, ADA, "me")).toBe(true);
    const me = teamSideView([mine, shared, mausbot()], [], ADA, "me"), team = teamSideView([mine, shared, mausbot()], [], ADA, "team");
    expect(ids(team.bots)).toEqual(["payroll"]);
    expect(ids(me.bots)).toEqual(["scout", "payroll", "mine"]);
    expect(me.bots[0]!.tasks.map((task) => task.threadId), "nothing of it is left where no list shows it").toEqual(["scout-main", "ada-own"]);
    expect(me.bots[0]!.messages, "its main chat on screen is on this side").toEqual([{ id: "m1" }]);
    expect(listedSide(mine, "scout-main")).toBe("me");
    expect(sideOfThread(mine, "scout-main"), "who reads it is still the server's answer: its owner and the admins, so never called private").toBe("team");
    setTeamChats(ADA);
    setTeamSide("team");
    expect(teamThreadToOpen(mine, ADA), "Team opens no shared chat of it").toBeNull();
    expect(teamThreadToOpen(shared, ADA)).toBe("payroll-main");

    const nowShared = { ...mine, access: { everyone: "none", people: { "ben@acme.test": "chat" } } };
    expect(ids(teamSideView([nowShared, mausbot()], [], ADA, "team").bots), "shared with one person, it is the team's too").toEqual(["scout"]);
    expect(teamSideView([nowShared, mausbot()], [], ADA, "me").bots[0]!.tasks.map((task) => task.threadId)).toEqual(["ada-own"]);
  });

  it("offers no switch when the only bots are ones nobody else can use", () => {
    const mine = scout([], { createdBy: "ada@acme.test", yourAccess: "edit", access: { everyone: "none", people: {} } });
    const view = teamSideView([mine, mausbot()], [], ADA, "me");
    expect(view.switchable).toBe(false);
    expect(ids(view.bots)).toEqual(["scout", "mine"]);
  });

  it("offers no switch, and hides nothing, when one side would be empty", () => {
    const onlyMine = teamSideView([mausbot()], [], ADA, "team");
    expect(onlyMine.switchable).toBe(false);
    expect(ids(onlyMine.bots)).toEqual(["mine"]);
    const onlyShared = teamSideView([scout([], { yourAccess: "view" })], [room()], ADA, "me");
    expect(onlyShared.switchable).toBe(false);
    expect(ids(onlyShared.bots)).toEqual(["scout"]);
    expect(ids(onlyShared.groups)).toEqual(["room-1"]);
    expect(teamSideView([mausbot()], [room()], ADA, "me").switchable, "a group chat alone makes a Team side").toBe(true);
  });

  it("leaves archived bots out of both sides", () => {
    expect(ids(teamSideView([scout(), mausbot(), scout([], { id: "old", hidden: true })], [], ADA, "team").bots)).toEqual(["scout"]);
  });
});

describe("each side's own unread mark", () => {
  const unread = (tasks: Extra[], groups = [room()]) => teamSideView([scout(tasks), mausbot()], groups, ADA, "me").unread;

  it("marks a side for this person's unread conversations on it, and not for a routine's run or an archived one", () => {
    expect(unread([])).toEqual({ me: false, team: false });
    expect(unread([{ threadId: "ada-own", private: true, unread: true }])).toEqual({ me: true, team: false });
    expect(unread([{ threadId: "ada-own", private: true }, { threadId: "report", unread: true }])).toEqual({ me: false, team: true });
    expect(unread([{ threadId: "run", unread: true, routineRunId: "r1" }, { threadId: "old", private: true, unread: true, archivedAt: 5 }])).toEqual({ me: false, team: false });
  });

  it("counts the shared chat and a group chat for Team, the person's own MausBot for Just me", () => {
    expect(teamSideView([{ ...scout(), tasks: [{ ...MAIN, unread: true }] }, mausbot()], [], ADA, "me").unread).toEqual({ me: false, team: true });
    expect(unread([], [room({ unread: true })])).toEqual({ me: false, team: true });
    expect(teamSideView([scout(), mausbot({ tasks: [{ threadId: "mine-main", unread: true }] })], [], ADA, "team").unread).toEqual({ me: true, team: false });
  });
});

describe("the remembered side", () => {
  it("is Just me until the person chose Team: one value for the whole team, kept on this device", () => {
    expect(teamSide(ADA)).toBe("me");
    setTeamSide("team", ADA);
    expect(teamSide(ADA)).toBe("team");
    expect(stored.get("omb.team-side.team-acme.ada@acme.test")).toBe("team");
    setTeamSide("me", ADA);
    expect(teamSide(ADA)).toBe("me");
  });

  it("is not rewritten by a side that is only shown: that lasts for the page, and the choice comes back with the next one", () => {
    setTeamChats(ADA);
    showTeamSide("team");
    expect(teamSide(), "what the sidebar shows now").toBe("team");
    expect(savedTeamSide(), "what the person chose").toBe("me");
    expect(stored.size, "nothing written").toBe(0);
    setTeamChats(null);
    setTeamChats(ADA);
    expect(teamSide(), "a new page").toBe("me");
    setTeamSide("team");
    showTeamSide("me");
    expect(stored.get("omb.team-side.team-acme.ada@acme.test")).toBe("team");
    setTeamSide("team");
    expect(teamSide(), "choosing again what is kept still moves the sidebar").toBe("team");
  });

  it("is each person's own on a shared device, and each team's", () => {
    setTeamSide("team", ADA);
    expect(teamSide(BEN)).toBe("me");
    expect(teamSide({ ...ADA, teamId: "team-other" })).toBe("me");
    expect(teamSide(null), "off a team").toBe("me");
  });

  it("works for the page's life before the person is known or where nothing can be stored, and never throws", () => {
    const anonymous: TeamChats = { teamId: "team-acme", member: true };
    setTeamSide("team", anonymous);
    expect(stored.size).toBe(0);
    expect(teamSide(anonymous)).toBe("team");
    setTeamSide("me", anonymous);
    stored.set("omb.team-side.team-acme.ada@acme.test", "nonsense");
    expect(teamSide(ADA)).toBe("me");
    expect(teamSide(ADA, null)).toBe("me");
  });
});

describe("opening a bot on the side the sidebar shows", () => {
  it("opens the person's own chat under Just me and the shared chat under Team, making nothing", async () => {
    setTeamChats(ADA);
    const bot = scout([{ threadId: "ada-own", private: true, createdAt: 2 }], { threadId: "elsewhere" });
    const dispatch = vi.fn();
    openBot(dispatch, bot, false);
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
    setTeamSide("team");
    dispatch.mockClear();
    openBot(dispatch, bot, false);
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "ada-own" }));
    await settle();
    expect(server.calls, "nothing is made").toEqual([]);
  });

  it("a new chat under Just me is made through the server's private route, with no audience of this page's choosing", async () => {
    setTeamChats(ADA);
    server.answer = { bot: scout([{ threadId: "ada-new", private: true }], { threadId: "ada-new" }), task: { threadId: "ada-new" } };
    const dispatch = vi.fn();
    openBot(dispatch, scout(), false);
    await settle();
    expect(server.calls).toEqual([["/api/bots/scout/tasks", { method: "POST", body: "{}" }]]);
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: "switchTask" }));
    expect(sideOfThread(scout(), "ada-new"), "and it is Just me from the moment it exists").toBe("me");
  });

  it("opens the person's own MausBot, which has no shared chat, as their own even under Team", async () => {
    setTeamChats(ADA);
    setTeamSide("team");
    const dispatch = vi.fn();
    openBot(dispatch, mausbot({ tasks: [{ threadId: "mine-main", private: true, createdAt: 1 }] }), false);
    await settle();
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "scout-main" }));
    expect(server.calls).toEqual([]);
  });

  it("is as ever off a team", () => {
    const dispatch = vi.fn();
    openBot(dispatch, { id: "scout", threadId: "scout-main", mainThreadId: "scout-main", tasks: [{ threadId: "scout-main" }] }, false);
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "scout" });
    expect(server.calls).toEqual([]);
  });
});
