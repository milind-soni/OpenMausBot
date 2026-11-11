import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { setInboxSupport } from "@/state/inbox";
import { setTeamPeople, type TeamPeople } from "@/state/team-people";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { BotListItem, botRowProps, TeamMenuItems } from "./Sidebar";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { MentionMenu, teammateChoices } from "./MentionMenu";
import { AskingLine, NeedsYouButton, NeedsYouTitle, PersonFace } from "./TeamOwner";
import { TeammateChip } from "./TeammateChip";

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member", you: true as const };
const asBob = (needsYou: TeamPeople["needsYou"] = []): TeamPeople => ({ people: [ADA, BOB], me: BOB, admin: false, needsYou });

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "fox", threadId: "fox-main", name: "Fox", title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [], ...overrides,
});
const withStore = (state: AppState, child: ReturnType<typeof createElement>) =>
  createElement(StoreContext.Provider, { value: { state, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, child);
const row = (candidate: Bot, selected = false) => {
  const state = { ...initialState, bots: [candidate], selectedId: selected ? candidate.id : null, activeView: "chat" } as AppState;
  return renderToStaticMarkup(createElement(BotListItem, botRowProps(state, vi.fn(), candidate, { density: "comfortable", query: "", onMenu: vi.fn() })));
};

afterEach(() => setTeamPeople(null));

describe("who looks after a team bot, in the sidebar", () => {
  it("shows no face on a bot's row, on a team or off it", () => {
    setTeamPeople(asBob());
    expect(row(bot({ createdBy: ADA.email, reportsTo: BOB.email }))).not.toContain("data-owner-face");
    expect(row(bot({ id: "stray" }))).not.toContain("Nobody");
    setTeamPeople(null);
    expect(row(bot({ createdBy: ADA.email }))).not.toContain("data-owner-face");
  });

  it("keeps the selected bot's ⋯ menu in view, not only on hover", () => {
    const actions = (markup: string) => markup.match(/<button[^>]*data-bot-actions="fox"[^>]*>/)?.[0] ?? "";
    expect(actions(row(bot(), true))).toContain("opacity-100");
    expect(actions(row(bot(), false))).toContain("opacity-0");
    expect(actions(row(bot(), false))).toContain("group-hover:opacity-100");
  });

  it("names no department caption for the person its bots report to", () => {
    const header = renderToStaticMarkup(createElement(SidebarSectionHeader, { name: "Product A", collapsed: false, reorderable: false, dragging: false, line: true }));
    expect(header).not.toContain("data-department-lead");
    expect(header).not.toContain("→");
  });

  it("a department's menu sets no owner for all its bots and opens no map of who owns what", () => {
    const items = renderToStaticMarkup(createElement(TeamMenuItems, { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn(), onSetForAll: vi.fn() }));
    expect(items).not.toMatch(/looks? after|owner/i);
    expect(items).toContain("Rename department");
  });
});

describe("a teammate's face", () => {
  const PICTURE = "/api/team/people/p_ada/picture?v=1";
  const withPicture = (): TeamPeople => ({ ...asBob(), people: [{ ...ADA, pictureUrl: PICTURE }, BOB] });
  const face = (person: Parameters<typeof PersonFace>[0]["person"], size?: number) => renderToStaticMarkup(createElement(PersonFace, { person, size }));

  it("shows the person's picture when they have one, at the face's size, and their initial when they don't", () => {
    setTeamPeople(withPicture());
    const ada = face({ ...ADA, pictureUrl: PICTURE }, 20);
    expect(ada).toMatch(/<img src="\/api\/team\/people\/p_ada\/picture\?v=1" alt="" aria-hidden="true"[^>]*data-person-picture="ada@acme.test"[^>]*style="width:20px;height:20px"[^>]*class="[^"]*rounded-full[^"]*object-cover/);
    const bob = face(BOB, 20);
    expect(bob).not.toContain("<img");
    expect(bob).toMatch(/^<span aria-hidden="true" style="width:20px;height:20px;font-size:11px" class="[^"]*rounded-full[^"]*">B<\/span>$/);
  });

  it("finds a teammate's picture by their address when only their name is at hand", () => {
    setTeamPeople(withPicture());
    expect(face({ email: ADA.email, name: "Ada", role: "member" })).toContain(`src="${PICTURE}"`);
    setTeamPeople(null);
    expect(face({ email: ADA.email, name: "Ada", role: "member" })).toMatch(/>A<\/span>$/);
  });

  it("is beside a card's Asking line", () => {
    setTeamPeople(withPicture());
    const fox = bot({ reportsTo: ADA.email, tasks: [{ threadId: "fox-main", title: "Fox" }] as Bot["tasks"] });
    const line = renderToStaticMarkup(withStore({ ...initialState, bots: [fox] } as AppState, createElement(AskingLine, { botId: "fox", threadId: "fox-main" })));
    expect(line).toMatch(/<img src="\/api\/team\/people\/p_ada\/picture\?v=1"[^>]*style="width:14px;height:14px"[^>]*>Asking Ada/);
  });

  it("is each teammate's face in the @ list, on a Told chip and on a Needs you line from them", () => {
    setTeamPeople(withPicture());
    const motion = { shown: true, closing: false, className: "", exitProps: {} };
    const menu = renderToStaticMarkup(createElement(MentionMenu, { listRef: { current: null }, motion, choices: teammateChoices([{ ...ADA, pictureUrl: PICTURE }, BOB]),
      highlight: 0, everyoneCount: 0, onPick: vi.fn(), onHighlight: vi.fn() }));
    expect(menu).toMatch(/<img src="\/api\/team\/people\/p_ada\/picture\?v=1"[^>]*style="width:24px;height:24px"[^>]*>[^]*?Ada</);
    expect(menu).toMatch(/<span aria-hidden="true" style="width:24px;height:24px[^"]*"[^>]*>B<\/span>[^]*?Bob</);
    const told = (name: string, email: string) => renderToStaticMarkup(createElement(TeammateChip, {
      message: { id: "m1", role: "bot", kind: "activity", relay: { kind: "told", email, name }, tool: { name: `Told ${name}`, ok: true, output: "hi" } } as never }));
    expect(told("Ada", ADA.email)).toContain(`src="${PICTURE}"`);
    expect(told("Bob", BOB.email)).toMatch(/>B<\/span>/);
    const from = (item: Partial<Extract<TeamPeople["needsYou"][number], { kind: "message" }>>) => renderToStaticMarkup(createElement(NeedsYouTitle,
      { item: { kind: "message", id: "n1", at: 1, botId: "fox", threadId: "fox-main", from: "Ada", text: "hi", ...item }, title: "Ada wrote to you" }));
    expect(from({ fromEmail: ADA.email })).toMatch(/<img src="\/api\/team\/people\/p_ada\/picture\?v=1"[^>]*>[^]*Ada wrote to you/);
    expect(from({ from: "Bob", fromEmail: BOB.email })).toMatch(/>B<\/span><span[^>]*>Ada wrote to you/);
    expect(from({ from: "Scout" }), "a bot's line has no face").toBe('<span class="w-full truncate text-[13px] text-ink">Ada wrote to you</span>');
  });
});

describe("a card waiting on someone", () => {
  const fox = bot({ reportsTo: ADA.email, tasks: [{ threadId: "fox-main", title: "Fox" }, { threadId: "fox-bob", title: "Mine", private: true }] as Bot["tasks"] });
  const asking = (threadId: string) => renderToStaticMarkup(withStore({ ...initialState, bots: [fox] } as AppState, createElement(AskingLine, { botId: "fox", threadId })));

  it("says whose answer it waits for in a shared chat, and nothing in a private one", () => {
    setTeamPeople(asBob());
    expect(asking("fox-main")).toContain("Asking Ada");
    expect(asking("fox-bob")).toBe("");
    setTeamPeople({ ...asBob(), people: [ADA, BOB] });
    const mine = renderToStaticMarkup(withStore({ ...initialState, bots: [{ ...fox, reportsTo: BOB.email }] } as AppState, createElement(AskingLine, { botId: "fox", threadId: "fox-main" })));
    expect(mine).toContain("Asking you");
  });

  it("says nothing off a team", () => {
    expect(asking("fox-main")).toBe("");
  });
});

describe("Needs you, on a server older than this page", () => {
  afterEach(() => setInboxSupport("unknown"));
  const render = () => renderToStaticMarkup(withStore({ ...initialState, bots: [bot()] } as AppState, createElement(NeedsYouButton)));

  it("counts what bots ask of this person, and hides when nothing does", () => {
    setInboxSupport("no");
    setTeamPeople(asBob([{ kind: "question", id: "q1", at: 1, botId: "fox", threadId: "fox-main", text: "Which landing page?" }]));
    expect(render()).toContain('aria-label="Needs you, 1"');
    setTeamPeople(asBob());
    expect(render()).toBe("");
  });

  it("gives way to the Inbox row on any server that has an inbox", () => {
    setInboxSupport("yes");
    setTeamPeople(asBob([{ kind: "question", id: "q1", at: 1, botId: "fox", threadId: "fox-main", text: "Which landing page?" }]));
    expect(render()).toBe("");
  });
});
