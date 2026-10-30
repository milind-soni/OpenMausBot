import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, StoreContext, type AppState, type Bot } from "@/state/store";
import { setTeamPeople, type TeamPeople } from "@/state/team-people";
import { TeamMenuItems } from "./SidebarTeamMenu";
import { MapModeToggle, setMapMode, showWhoReportsToWhom, TeamOrgChart, useMapMode } from "./TeamOrgChart";

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member", you: true as const };
const asBob = (admin = false): TeamPeople => ({ people: [ADA, BOB], me: BOB, admin, needsYou: [] });
const bot = (id: string, overrides: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-main`, name: id, title: "", description: "", notifications: true, color: "green", unread: false,
  modelSelection: { instanceId: "claude", model: "test" }, messages: [], ...overrides,
});
const bots = [
  bot("Fox", { section: "Product A", createdBy: ADA.email, reportsTo: BOB.email }),
  bot("Tech Lead", { section: "Product A", createdBy: BOB.email, reportsTo: ADA.email }),
  bot("Ada's Chief", { chiefOfStaff: true, reportsTo: ADA.email }),
];
const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(StoreContext.Provider,
  { value: { state: { ...initialState, bots } as AppState, dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn() } as never }, node));

afterEach(() => { setTeamPeople(null); setMapMode("departments"); });

describe("the Team map's Who reports to whom", () => {
  it("shows each person with their Chief and the bots that report to them, by department", () => {
    setTeamPeople(asBob());
    const chart = render(createElement(TeamOrgChart, { bots }));
    expect(chart).toMatch(/data-org-person="bob@acme.test"[\s\S]*Bob \(you\)[\s\S]*No Chief of Staff[\s\S]*data-org-department="Product A"[\s\S]*data-org-bot="Fox"/);
    expect(chart).toMatch(/data-org-person="ada@acme.test"[\s\S]*Chief of Staff[\s\S]*data-org-bot="Ada&#x27;s Chief"[\s\S]*data-org-bot="Tech Lead"/);
  });

  it("heads each person's column with their picture, or their initial when they have none", () => {
    setTeamPeople({ ...asBob(), people: [{ ...ADA, pictureUrl: "/api/team/people/p_ada/picture?v=1" }, BOB] });
    const chart = render(createElement(TeamOrgChart, { bots }));
    expect(chart).toMatch(/data-org-person="ada@acme.test"[^>]*><header[^>]*><img src="\/api\/team\/people\/p_ada\/picture\?v=1"[^>]*style="width:30px;height:30px"/);
    expect(chart).toMatch(/data-org-person="bob@acme.test"[^>]*><header[^>]*><span aria-hidden="true"[^>]*>B<\/span>/);
  });

  it("lets a member drag only the bots that report to them; an Admin drags any", () => {
    setTeamPeople(asBob());
    const member = render(createElement(TeamOrgChart, { bots }));
    expect(member).toMatch(/data-org-bot="Fox" draggable="true"/);
    expect(member).not.toMatch(/data-org-bot="Tech Lead" draggable="true"/);
    setTeamPeople(asBob(true));
    expect(render(createElement(TeamOrgChart, { bots }))).toMatch(/data-org-bot="Tech Lead" draggable="true"/);
  });

  it("shows nothing anywhere but a team", () => {
    expect(render(createElement(TeamOrgChart, { bots }))).toBe("");
  });

  it("switches between departments and people, and the department menu opens it", () => {
    expect(renderToStaticMarkup(createElement(MapModeToggle))).toMatch(/aria-pressed="true"[^>]*>Departments</);
    const dispatch = vi.fn();
    showWhoReportsToWhom(dispatch);
    expect(dispatch).toHaveBeenCalledWith({ type: "showTeamMap" });
    expect(renderToStaticMarkup(createElement(MapModeToggle))).toMatch(/aria-pressed="true"[^>]*>Who reports to whom</);
    const Probe = () => useMapMode();
    expect(renderToStaticMarkup(createElement(Probe))).toBe("people");
    const items = (onSeeReports?: () => void) => renderToStaticMarkup(createElement(TeamMenuItems, { onAddBots: vi.fn(), onRename: vi.fn(), onShare: vi.fn(), onDelete: vi.fn(), onSeeReports }));
    expect(items(vi.fn())).toContain("See who reports to whom");
    expect(items()).not.toContain("See who reports to whom");
  });
});
