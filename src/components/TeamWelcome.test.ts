// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), api: vi.fn(), people: null as any }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: fixture.api,
}));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("@/state/team-people", async (original) => ({ ...await original<typeof import("@/state/team-people")>(), useTeamPeople: () => fixture.people }));
import { TeamWelcome } from "./TeamWelcome";
import { teamPrivateChatsLineDue } from "./TeamPrivateChatsLine";
import { finishTeamWelcome, parseTeamWelcome, resetTeamWelcome, teamWelcomeDue, teamWelcomeView } from "@/lib/team-welcome";

const ACME = { id: "team-acme", name: "Acme" };
const people = [
  { email: "sam@acme.test", name: "Sam", role: "member", you: true as const },
  { email: "ada@acme.test", name: "Ada Lovelace", role: "owner", pictureUrl: "/api/team/people/p_a/picture?v=1" },
  { email: "ben@acme.test", name: "", role: "admin" },
];
const bot = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, title: "", description: "", tasks: [], threadId: `${id}-main`, mainThreadId: `${id}-main`, avatarCrop: "mascot", ...extra });
const bots = [
  bot("mine", "MausBot", { defaultBot: { person: "sam@acme.test" } }),
  bot("payroll", "Payroll", { description: "Runs payroll every month.\nAsk it anything about pay.", yourAccess: "view" }),
  bot("support", "Support", { title: "Answers customers" }),
  bot("old", "Old", { hidden: true }),
];

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } });
  setLocale("en");
  resetTeamWelcome();
  fixture.dispatch.mockReset(); fixture.api.mockReset().mockResolvedValue({});
  fixture.state = { bots, groups: [], config: { team: ACME } };
  fixture.people = { people, me: people[0], admin: false, needsYou: [] };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { root.unmount(); container.remove(); });
const render = (invitedBy: string | null = "ada@acme.test") => flushSync(() => root.render(createElement(TeamWelcome, { team: ACME, invitedBy })));

describe("a new member's first screen in a team", () => {
  it("names the team and who invited them, shows who else is in it and the bots shared with them, says the privacy rule once, and offers one chat", () => {
    render();
    expect(container.querySelector("h1")?.textContent).toBe("Welcome to Acme");
    expect(container.querySelector("[data-team-welcome-invited]")?.textContent).toBe("Ada Lovelace invited you to Acme.");
    expect([...container.querySelectorAll("[data-team-welcome-person] span.truncate")].map((row) => row.textContent)).toEqual(["Ada Lovelace", "ben@acme.test"]);
    expect(container.querySelector('[data-team-welcome-person="ada@acme.test"] img')?.getAttribute("src")).toBe("/api/team/people/p_a/picture?v=1");
    // Their own MausBot isn't shared with them, and a hidden bot isn't shown; one line each.
    expect([...container.querySelectorAll("[data-team-welcome-bot]")].map((row) => row.textContent)).toEqual(["PayrollRuns payroll every month.", "SupportAnswers customers"]);
    expect(container.querySelectorAll("[data-team-private-chats]")).toHaveLength(1);
    expect(container.querySelector("[data-team-private-chats]")?.textContent).toBe("Your chats in Acme are private. Only you can see them: not other members, not Acme's admins.");
    expect(teamPrivateChatsLineDue(ACME.id, localStorage), "the first private chat won't say it again").toBe(false);
    // A bot they can only view is not the first chat.
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Start a chat with Support", "Not now"]);
  });

  it("the one action opens a chat with that bot and keeps the welcome seen, for this person, on the team's Cloud", async () => {
    render();
    flushSync(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Start a chat with Support")!.click());
    expect(fixture.api).toHaveBeenCalledWith("/api/me/welcome", { method: "PUT", body: JSON.stringify({ welcomed: true }), timeoutMs: 10_000 });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "showChat" });
    expect(fixture.dispatch.mock.calls.some(([action]) => action.type === "select" && action.id === "support" || action.botId === "support")).toBe(true);
  });

  it("an older Admin that never said who invited them, or nobody else and no bots yet: still plain, with one way on", () => {
    fixture.people = { people: [people[0]], me: people[0], admin: false, needsYou: [] };
    fixture.state = { ...fixture.state, bots: [bots[0]] };
    render(null);
    expect(container.querySelector("[data-team-welcome-invited]")?.textContent).toBe("You’re in Acme now.");
    expect(container.querySelector("[data-team-welcome-person]")).toBeNull();
    expect(container.textContent).toContain("No bots are shared with you in Acme yet. Your own MausBot is in the sidebar.");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Look around"]);
  });
});

describe("when it shows", () => {
  it("only to a User of a team who hasn't seen it, once their record is read; an Admin has the Cloud's own welcome", () => {
    const fresh = { invitedBy: null, welcomedAt: null, hints: [] };
    expect(teamWelcomeDue({ team: ACME, canSave: false, record: fresh })).toBe(true);
    expect(teamWelcomeDue({ team: ACME, canSave: false, record: { ...fresh, welcomedAt: 1 } })).toBe(false);
    expect(teamWelcomeDue({ team: ACME, canSave: false, record: undefined }), "not yet read").toBe(false);
    expect(teamWelcomeDue({ team: ACME, canSave: false, record: null }), "a Team Cloud too old to keep one").toBe(false);
    expect(teamWelcomeDue({ team: ACME, canSave: true, record: fresh })).toBe(false);
    expect(teamWelcomeDue({ team: null, canSave: false, record: fresh })).toBe(false);
  });

  it("reads the record as the server keeps it, and nothing else", () => {
    expect(parseTeamWelcome({ invitedBy: "ada@acme.test", welcomedAt: 5, hints: ["a", 3] })).toEqual({ invitedBy: "ada@acme.test", welcomedAt: 5, hints: ["a"] });
    expect(parseTeamWelcome({ invitedBy: "nobody", welcomedAt: -1 })).toEqual({ invitedBy: null, welcomedAt: null, hints: [] });
    expect(parseTeamWelcome(undefined)).toBeNull();
  });

  it("an inviter not on the people list yet is named by their address; a long team shows a few and how many more", () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ email: `p${index}@acme.test`, name: `P${index}`, role: "member" }));
    const view = teamWelcomeView({ invitedBy: "boss@acme.test", people: many, bots: [] });
    expect(view.inviter).toEqual({ email: "boss@acme.test", name: "", role: "member" });
    expect([view.people.length, view.morePeople]).toEqual([6, 3]);
    expect(view.first).toBeNull();
  });

  it("seen here goes at once, even when the team's Cloud can't save it now", async () => {
    fixture.api.mockRejectedValue(new Error("offline"));
    await finishTeamWelcome(ACME.id);
    expect(fixture.api).toHaveBeenCalledTimes(1);
  });
});
