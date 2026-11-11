// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group, Task } from "@/state/store";

const fixture = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: null as unknown,
  calls: [] as Array<[string, RequestInit | undefined]>,
  answer: null as unknown,
}));
const api = vi.hoisted(() => async (path: string, init?: RequestInit) => { fixture.calls.push([path, init]); return fixture.answer; });
vi.mock("@/state/api", () => ({ api }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, api, useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/use-media-query", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/use-media-query")>(), useMediaQuery: () => true }));

const { initialState } = await import("@/state/store");
const { setTeamChats } = await import("@/state/team-chats");
const { savedTeamSide, setTeamSide, teamSide, teamSideView } = await import("@/state/team-side");
const { botShowsUnread } = await import("@/lib/bot-unread");
const { forgetShownConversations, TeamAudienceLabel, TeamSideSwitch } = await import("./TeamSideSwitch");
const { BotConversations, forgetConversationLines } = await import("./bot-panel/Conversations");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ADA = { teamId: "team-acme", member: true, opened: [] as string[], person: "ada@acme.test" };
const now = Date.now();
const task = (threadId: string, title: string, extra: Partial<Task> = {}): Task => ({ threadId, title, createdAt: now - 60_000, updatedAt: now - 30_000, ...extra });
const MAIN = task("scout-main", "Shared chat", { sharedChat: true });
const OWN = task("ada-own", "Pricing notes", { private: true });
const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "scout", threadId: "scout-main", mainThreadId: "scout-main", name: "Scout", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [], tasks: [MAIN, OWN], ...overrides,
} as Bot);
const MINE = bot({ id: "mine", name: "MausBot", threadId: "mine-main", mainThreadId: "mine-main", defaultBot: { person: "ada@acme.test" } as never, tasks: [task("mine-main", "Inbox")] });
const ROOM = { id: "room-1", name: "Relaunch", threadId: "room-thread", unread: false, members: [], messages: [] } as unknown as Group;
const acme = (extra: Partial<AppState> = {}): AppState =>
  ({ ...initialState, config: { team: { id: "team-acme", name: "Acme" } }, bots: [bot(), MINE], groups: [ROOM], selectedId: "scout", activeView: "chat", ...extra }) as unknown as AppState;

let root: Root;
let host: HTMLElement;
const draw = (state: AppState, ...children: ReturnType<typeof createElement>[]) => {
  fixture.state = state;
  act(() => root.render(createElement("div", null, ...children)));
};
const sidebar = (state: AppState = acme(), compact = false) => draw(state, createElement(TeamSideSwitch, { compact }));
const option = (side: "me" | "team") => host.querySelector<HTMLButtonElement>(`[data-team-side-option="${side}"]`);
const checked = () => host.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute("data-team-side-option");
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } });
  fixture.dispatch.mockReset();
  fixture.calls.length = 0;
  fixture.answer = null;
  forgetShownConversations();
  setTeamChats(ADA);
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setTeamChats(null);
  forgetConversationLines();
  vi.unstubAllGlobals();
});

describe("the Just me / Team switch at the top of a team's sidebar", () => {
  it("shows on a team's Cloud only", () => {
    sidebar();
    expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("Whose chats to show");
    expect([...host.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent)).toEqual(["Just me", "Team"]);
    expect(checked(), "Just me until the person chooses").toBe("me");
    setTeamChats(null);
    sidebar({ ...initialState, bots: [bot()] } as AppState);
    expect(host.innerHTML, "a personal install and My Cloud").toBe("<div></div>");
  });

  it("shows no switch, never a disabled one, when the person has one side only", () => {
    sidebar(acme({ bots: [MINE], groups: [] }));
    expect(host.querySelector('[role="radio"]')).toBeNull();
    sidebar(acme());
    expect(host.querySelector("[disabled]")).toBeNull();
  });

  it("choosing Team shows the shared side and opens this bot's shared chat, making nothing", async () => {
    sidebar(acme({ bots: [bot({ threadId: "ada-own" }), MINE] }));
    act(() => option("team")!.click());
    await settle();
    expect(checked()).toBe("team");
    expect(teamSide()).toBe("team");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    expect(fixture.calls).toEqual([]);
  });

  it("choosing Just me opens the person's own chat with this bot, never the shared one", async () => {
    setTeamSide("team");
    sidebar();
    act(() => option("me")!.click());
    await settle();
    expect(checked()).toBe("me");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
    expect(fixture.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ threadId: "scout-main" }));
  });

  it("choosing Team from a private-only bot opens the first shared bot instead", async () => {
    sidebar(acme({ selectedId: "mine" }));
    act(() => option("team")!.click());
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
  });

  it("on a phone's bot list, which covers the conversation, changes the list and opens nothing", async () => {
    draw(acme({ bots: [bot({ threadId: "ada-own" }), MINE] }), createElement(TeamSideSwitch, { compact: false, listOnly: true }));
    act(() => option("team")!.click());
    await settle();
    expect(checked()).toBe("team");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
  });

  it("never lands on a bot the person keeps out of their sidebar", async () => {
    setTeamSide("team");
    sidebar(acme({ selectedId: "room-1", bots: [{ ...MINE, sidebarHidden: true } as Bot, bot()] }));
    act(() => option("me")!.click());
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
  });

  it("moves no conversation while another screen is up, and does nothing for the side already chosen", async () => {
    sidebar(acme({ activeView: "routines" as never }));
    act(() => option("me")!.click());
    act(() => option("team")!.click());
    await settle();
    expect(teamSide()).toBe("team");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("marks the side not shown when this person has something unread there, and never the side shown", () => {
    sidebar(acme({ bots: [bot({ tasks: [{ ...MAIN, unread: true }, OWN] }), MINE] }));
    expect(option("team")!.querySelector('[data-team-side-unread="team"]')?.getAttribute("aria-label")).toBe("Unread");
    expect(option("me")!.querySelector("[data-team-side-unread]")).toBeNull();
    setTeamSide("team");
    sidebar(acme({ bots: [bot({ tasks: [{ ...MAIN, unread: true }, { ...OWN, unread: true }] }), MINE] }));
    expect(option("me")!.querySelector('[data-team-side-unread="me"]')).not.toBeNull();
    expect(option("team")!.querySelector("[data-team-side-unread]"), "the side shown").toBeNull();
    sidebar(acme({ groups: [{ ...ROOM, unread: true }] }));
    expect(host.querySelector("[data-team-side-unread]"), "Team is shown: its group chat's mark is in the list").toBeNull();
  });

  it("stays reachable when the sidebar is a rail of icons: two named buttons, the same marks", () => {
    sidebar(acme({ bots: [bot({ tasks: [{ ...MAIN, unread: true }, OWN] }), MINE] }), true);
    expect([...host.querySelectorAll('[role="radio"]')].map((radio) => radio.getAttribute("aria-label"))).toEqual(["Just me", "Team"]);
    expect(option("team")!.querySelector("[data-team-side-unread]")).not.toBeNull();
    expect(host.querySelector("[data-team-side-hint]")).toBeNull();
  });

  it("explains the switch in one line the first time it is seen on this device, and never again", () => {
    sidebar();
    expect(host.querySelector("[data-team-side-hint]")?.textContent).toBe("Just me is private, even from admins. Team is shared.");
    act(() => root.unmount());
    root = createRoot(host);
    sidebar();
    expect(host.querySelector("[data-team-side-hint]")).toBeNull();
  });
});

describe("who can see it, by the message box", () => {
  const label = () => host.querySelector("[data-team-audience]");
  const box = (state: AppState, props: { bot?: Bot; group?: Group }) => draw(state, createElement(TeamSideSwitch, { compact: false }), createElement(TeamAudienceLabel, { key: props.group?.threadId ?? props.bot?.threadId, ...props }));

  it("says Private on a private chat and Shared on a shared one, from the conversation itself", () => {
    box(acme(), { bot: bot({ threadId: "ada-own" }) });
    expect(label()?.getAttribute("data-team-audience")).toBe("me");
    expect(label()?.textContent).toBe("Private · only you");
    box(acme(), { bot: bot({ threadId: "scout-main" }) });
    expect(label()?.textContent).toBe("Shared · everyone in Acme can see");
    box(acme(), { bot: bot({ threadId: "scout-main", onlyPeopleAdded: true }) });
    expect(label()?.textContent).toBe("Shared · only people added and admins can see");
    box(acme(), { group: ROOM });
    expect(label()?.textContent).toBe("Shared · everyone in this group chat can see");
    box(acme(), { bot: MINE });
    expect(label()?.textContent, "the person's own MausBot").toBe("Private · only you");
  });

  it("never follows the switch: with Just me chosen, a shared chat on screen still says Shared", () => {
    setTeamSide("me");
    forgetShownConversations();
    draw(acme(), createElement(TeamAudienceLabel, { bot: bot({ threadId: "scout-main", switchingTo: "ada-own" }) }));
    expect(label()?.textContent).toBe("Shared · everyone in Acme can see");
    draw(acme(), createElement(TeamAudienceLabel, { bot: bot({ threadId: "never-heard-of", tasks: [MAIN] }) }));
    expect(label()?.getAttribute("data-team-audience"), "a conversation this page knows nothing of is never called private").toBe("team");
  });

  it("shows nothing off a team", () => {
    setTeamChats(null);
    draw({ ...initialState, bots: [bot()] } as AppState, createElement(TeamAudienceLabel, { bot: bot() }));
    expect(host.innerHTML).toBe("<div></div>");
  });

  it("moves the switch to a conversation the person asked for by name, from a notification or a link, and keeps that as their choice", () => {
    box(acme({ revealThread: { threadId: "scout-main", nonce: 1 } }), { bot: bot({ threadId: "scout-main" }) });
    expect(checked(), "the shared chat they opened").toBe("team");
    expect(savedTeamSide()).toBe("team");
    box(acme({ revealThread: { threadId: "ada-own", nonce: 2 } }), { bot: bot({ threadId: "ada-own" }) });
    expect(checked()).toBe("me");
    expect(savedTeamSide()).toBe("me");
    expect(fixture.dispatch, "following moves the switch, never the conversation").not.toHaveBeenCalled();
  });

  it("moves the switch when the person goes to another bot or a group chat of the other side", () => {
    box(acme(), { bot: bot({ threadId: "ada-own" }) });
    expect(checked()).toBe("me");
    box(acme({ selectedId: "room-1" }), { group: ROOM });
    expect(checked()).toBe("team");
    expect(savedTeamSide()).toBe("team");
    box(acme({ selectedId: "mine" }), { bot: MINE });
    expect(checked(), "their own MausBot, picked from search").toBe("me");
    expect(savedTeamSide()).toBe("me");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("moves the switch to Just me for a conversation the person just made beside a shared chat", () => {
    setTeamSide("team");
    const before = bot({ threadId: "scout-main", tasks: [MAIN] });
    box(acme({ bots: [before, MINE] }), { bot: before });
    const made = bot({ threadId: "ada-new", tasks: [MAIN, task("ada-new", "New chat", { private: true })] });
    box(acme({ bots: [made, MINE] }), { bot: made });
    expect(checked()).toBe("me");
    expect(label()?.textContent).toBe("Private · only you");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("after a reload with Just me chosen, goes to the person's own chat with the bot and never saves Team from what the page showed first", () => {
    box(acme(), { bot: bot({ threadId: "scout-main" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
    expect(checked(), "the switch does not move for it").toBe("me");
    expect(savedTeamSide()).toBe("me");
    expect(stored.get("omb.team-side.team-acme.ada@acme.test")).not.toBe("team");
    expect(label()?.textContent, "and until their chat is on screen the label says what is").toBe("Shared · everyone in Acme can see");
  });

  it("goes back to the person's own chat when the bot's own pick puts its shared chat on screen under them, and keeps their choice", () => {
    box(acme({ revealThread: { threadId: "ada-own", nonce: 1 } }), { bot: bot({ threadId: "ada-own" }) });
    expect(checked()).toBe("me");
    fixture.dispatch.mockReset();
    box(acme({ revealThread: { threadId: "ada-own", nonce: 1 } }), { bot: bot({ threadId: "scout-main" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
    expect(checked()).toBe("me");
    expect(savedTeamSide(), "nobody chose Team").toBe("me");
    expect(stored.get("omb.team-side.team-acme.ada@acme.test")).not.toBe("team");
  });

  it("does not take the shared chat the app opened as it started, before it knew this is a team, for the person's choice", () => {
    setTeamChats(null);
    const starting = { ...initialState, bots: [bot({ threadId: "ada-own", switchingTo: "scout-main" }), MINE], revealThread: { threadId: "scout-main", nonce: 7 } } as unknown as AppState;
    draw(starting, createElement(TeamSideSwitch, { compact: false }));
    setTeamChats(ADA);
    box(acme({ revealThread: { threadId: "scout-main", nonce: 7 } }), { bot: bot({ threadId: "scout-main" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "ada-own" });
    expect(checked()).toBe("me");
    expect(savedTeamSide(), "nobody chose Team").toBe("me");
    expect(stored.get("omb.team-side.team-acme.ada@acme.test")).not.toBe("team");
  });

  it("after a reload with Team chosen, goes to the bot's shared chat and keeps Team", () => {
    setTeamSide("team");
    box(acme(), { bot: bot({ threadId: "ada-own" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    expect(teamSide()).toBe("team");
    expect(savedTeamSide()).toBe("team");
    expect(label()?.textContent, "and the label still says what is on screen").toBe("Private · only you");
  });

  it("waits while a conversation is on its way, and takes no notice of a message box that is not the chat on screen", () => {
    box(acme(), { bot: bot({ threadId: "scout-main", switchingTo: "ada-own" }) });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(checked()).toBe("me");
    box(acme({ selectedId: "mine" }), { bot: MINE });
    box(acme(), { bot: bot({ threadId: "scout-main", switchingTo: "ada-own" }) });
    expect(savedTeamSide(), "coming from another bot, its own chat still loading over the shared one").toBe("me");
    expect(checked()).toBe("me");
    setTeamSide("team");
    box(acme({ selectedId: "scout" }), { bot: MINE });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(teamSide(), "an inbox's reply box beside the chat").toBe("team");
  });

  it("opens a new person's page on Just me, their own chat with the bot on screen made as a click on it makes it", async () => {
    box(acme({ bots: [bot({ tasks: [MAIN] }), MINE] }), { bot: bot({ tasks: [MAIN] }) });
    await settle();
    expect(fixture.calls).toEqual([["/api/bots/scout/tasks", { method: "POST", body: "{}" }]]);
    expect(teamSide(), "Just me until they choose Team").toBe("me");
  });

  it("goes to another bot of the chosen side when the one on screen is not listed there", () => {
    setTeamSide("team");
    box(acme({ selectedId: "mine" }), { bot: MINE });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    expect(savedTeamSide()).toBe("team");
  });

  it("with nowhere to go on the chosen side, shows the side on screen without keeping it", async () => {
    const viewOnly = bot({ yourAccess: "view", tasks: [MAIN] });
    box(acme({ bots: [viewOnly], groups: [] }), { bot: viewOnly });
    await settle();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(teamSide()).toBe("team");
    expect(savedTeamSide(), "nobody chose it").toBe("me");
  });
});

describe("each side's rows carry only that side's marks", () => {
  const rows = (bots: Bot[], side: "me" | "team") => teamSideView(bots, [ROOM], ADA, side).bots;

  it("puts no unread mark on a Just me row for something unread in the bot's shared chat", () => {
    const sharedUnread = bot({ unread: true, tasks: [{ ...MAIN, unread: true }] });
    expect(botShowsUnread(sharedUnread), "the bot as the server sent it").toBe(true);
    const [row] = rows([sharedUnread, MINE], "me");
    expect(row!.id).toBe("scout");
    expect(botShowsUnread(row!), "no private conversation there, so no mark").toBe(false);
    expect(botShowsUnread(rows([sharedUnread, MINE], "team")[0]!)).toBe(true);
  });

  it("puts no unread mark on a Team row for something unread in a private chat, and none of a run on the other side", () => {
    const privateUnread = bot({ unread: true, threadId: "ada-own", busy: true, tasks: [MAIN, { ...OWN, unread: true }] });
    const team = rows([privateUnread, MINE], "team")[0]!;
    expect(botShowsUnread(team)).toBe(false);
    expect(team.busy, "her private run is not the shared chat's").toBe(false);
    const me = rows([privateUnread, MINE], "me")[0]!;
    expect(botShowsUnread(me)).toBe(true);
    expect(me.busy).toBe(true);
  });
});

describe("a bot's own list of conversations", () => {
  const SECOND = task("ada-second", "Supplier call", { private: true });
  const REPORT = task("report", "Weekly numbers", {});
  const listed = (shown: Bot, state: AppState = acme()) => {
    draw(state, createElement(BotConversations, { bot: shown }));
    return [...host.querySelectorAll("[data-conversation]")].map((row) => row.getAttribute("data-conversation")).sort();
  };

  it("lists the person's private chats beside a private chat, with New conversation", () => {
    expect(listed(bot({ threadId: "ada-own", tasks: [MAIN, OWN, SECOND, REPORT] }))).toEqual(["ada-own", "ada-second"]);
    expect(host.querySelector("[data-conversations-new]")).not.toBeNull();
  });

  it("lists the shared conversations beside a shared chat, no private one, and offers no new conversation there", () => {
    expect(listed(bot({ threadId: "scout-main", tasks: [MAIN, OWN, SECOND, REPORT] }))).toEqual(["report", "scout-main"]);
    expect(host.querySelector("[data-conversations-new]"), "a new conversation is always private, so it is offered under Just me").toBeNull();
  });

  it("lists every conversation as before off a team", () => {
    setTeamChats(null);
    expect(listed(bot({ threadId: "scout-main", tasks: [task("scout-main", "First"), task("second", "Second")] }), initialState)).toEqual(["scout-main", "second"]);
    expect(host.querySelector("[data-conversations-new]")).not.toBeNull();
  });
});
