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
const { setTeamSide, teamSide } = await import("@/state/team-side");
const { forgetTeamSideRestore, TeamAudienceLabel, TeamSideSwitch } = await import("./TeamSideSwitch");
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
  forgetTeamSideRestore();
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
    expect(host.querySelector("[data-team-side-hint]")?.textContent).toBe("Just me shows your private chats: nobody else can read them, admins included. Team shows what everyone shares.");
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
    forgetTeamSideRestore();
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

  it("moves the switch to match a conversation opened on the other side, from a notification or a link", () => {
    box(acme(), { bot: bot({ threadId: "ada-own" }) });
    expect(checked()).toBe("me");
    box(acme(), { bot: bot({ threadId: "scout-main" }) });
    expect(checked(), "the shared chat came on screen").toBe("team");
    expect(teamSide()).toBe("team");
    box(acme(), { bot: MINE });
    expect(checked()).toBe("me");
    box(acme(), { group: ROOM });
    expect(checked()).toBe("team");
    expect(fixture.dispatch, "following moves the switch, never the conversation").not.toHaveBeenCalled();
  });

  it("brings the page's first conversation to the side the person last used, when this bot has one there", () => {
    setTeamSide("team");
    box(acme(), { bot: bot({ threadId: "ada-own" }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    expect(teamSide(), "still the side they chose").toBe("team");
    expect(label()?.textContent, "and the label still says what is on screen").toBe("Private · only you");
  });

  it("leaves a conversation a link or a notification asked for where it is, and follows it", () => {
    setTeamSide("team");
    box(acme({ revealThread: { threadId: "ada-own", nonce: 1 } }), { bot: bot({ threadId: "ada-own" }) });
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(teamSide()).toBe("me");
  });

  it("opens a new person's page on Just me, their own chat with the bot on screen made as a click on it makes it", async () => {
    box(acme({ bots: [bot({ tasks: [MAIN] }), MINE] }), { bot: bot({ tasks: [MAIN] }) });
    await settle();
    expect(fixture.calls).toEqual([["/api/bots/scout/tasks", { method: "POST", body: "{}" }]]);
    expect(teamSide(), "Just me until they choose Team").toBe("me");
  });

  it("opens the page on the remembered side with another bot when the one on screen is not listed there, and follows when nothing is", async () => {
    setTeamSide("team");
    box(acme(), { bot: MINE });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "scout-main" });
    forgetTeamSideRestore();
    fixture.dispatch.mockReset();
    setTeamSide("me");
    box(acme({ bots: [bot({ yourAccess: "view", tasks: [MAIN] })], groups: [] }), { bot: bot({ yourAccess: "view", tasks: [MAIN] }) });
    await settle();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(teamSide()).toBe("team");
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
