import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { departmentOwner, setTeamPeople, type TeamPeople } from "@/state/team-people";

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
  return renderToStaticMarkup(createElement(BotListItem, botRowProps(state, vi.fn(), candidate, { density: "comfortable", quiet: false, query: "", onMenu: vi.fn() })));
};

afterEach(() => setTeamPeople(null));

describe("who a team bot reports to, in the sidebar", () => {
  it("shows the owner's face at the end of the row, which only the owner or an Admin can change", () => {
    setTeamPeople(asBob());
    const fox = row(bot({ createdBy: ADA.email, reportsTo: BOB.email }));
    expect(fox).toMatch(/<button[^>]*data-owner-face="bob@acme.test"[^>]*title="Reports to Bob: questions and reports go to Bob"/);
    const lead = row(bot({ id: "lead", name: "Tech Lead", createdBy: BOB.email, reportsTo: ADA.email }));
    expect(lead).toMatch(/<span data-owner-face="ada@acme.test" role="img" aria-label="Reports to Ada: questions and reports go to Ada"/);
    expect(lead).not.toMatch(/<button[^>]*data-owner-face/);
    setTeamPeople({ ...asBob(), admin: true });
    expect(row(bot({ id: "lead", createdBy: BOB.email, reportsTo: ADA.email }))).toMatch(/<button[^>]*data-owner-face="ada@acme.test"/);
    expect(row(bot({ id: "stray" }))).toContain("Nobody owns this bot yet, so its questions go to the admins.");
  });

  it("shows no face anywhere but a team", () => {
    expect(row(bot({ createdBy: ADA.email }))).not.toContain("data-owner-face");
  });

  it("keeps the selected bot's ⋯ menu in view, not only on hover", () => {
    const actions = (markup: string) => markup.match(/<button[^>]*data-bot-actions="fox"[^>]*>/)?.[0] ?? "";
    expect(actions(row(bot(), true))).toContain("opacity-100");
    expect(actions(row(bot(), false))).toContain("opacity-0");
    expect(actions(row(bot(), false))).toContain("group-hover:opacity-100");
  });

  it("names a department's owner beside it when every bot there reports to one person", () => {
    const team = asBob();
    expect(departmentOwner([bot({ reportsTo: BOB.email }), bot({ id: "owl", createdBy: BOB.email })], team)?.name).toBe("Bob");
    expect(departmentOwner([bot({ reportsTo: BOB.email }), bot({ id: "lead", reportsTo: ADA.email })], team)).toBeNull();
    const header = renderToStaticMarkup(createElement(SidebarSectionHeader, { name: "Product A", lead: "Bob", collapsed: false, reorderable: false, dragging: false, line: true }));
    expect(header).toContain(">→ Bob<");
    expect(header).toContain("Every bot in Product A reports to Bob");
  });

  it("offers Set owner for all bots in a department's menu only when the caller passes it", () => {
    const items = (onSetOwner?: () => void) => renderToStaticMarkup(createElement(TeamMenuItems, { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn(), onSetOwner }));
    expect(items(vi.fn())).toContain("Set owner for all bots…");
    expect(items()).not.toContain("Set owner for all bots…");
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

  it("is the owner's face at the end of a bot's row and beside a card's Asking line", () => {
    setTeamPeople(withPicture());
    expect(row(bot({ createdBy: BOB.email, reportsTo: ADA.email }))).toMatch(/data-owner-face="ada@acme.test"[^>]*>[^]*?<img src="\/api\/team\/people\/p_ada\/picture\?v=1"/);
    expect(row(bot({ createdBy: ADA.email, reportsTo: BOB.email }))).toMatch(/data-owner-face="bob@acme.test"[^>]*><span aria-hidden="true"[^>]*>B<\/span>/);
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

describe("Needs you", () => {
  it("counts what bots ask of this person, and hides when nothing does", () => {
    const render = () => renderToStaticMarkup(withStore({ ...initialState, bots: [bot()] } as AppState, createElement(NeedsYouButton)));
    setTeamPeople(asBob([{ kind: "question", id: "q1", at: 1, botId: "fox", threadId: "fox-main", text: "Which landing page?" }]));
    expect(render()).toContain('aria-label="Needs you, 1"');
    setTeamPeople(asBob());
    expect(render()).toBe("");
  });
});
