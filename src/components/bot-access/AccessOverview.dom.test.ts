// @vitest-environment happy-dom
// Settings → Bot access in a real DOM: the team's bots, each row opening the Share dialog; the team's people, each with
// their bots at quiet level menus; and a viewer's "Ask Ada to chat".
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }>, bots: [] as unknown[], answer: {} as unknown }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return server.answer;
  }),
  useStore: () => ({ state: { config: { team: { id: "team-acme", name: "Acme" } }, bots: server.bots }, dispatch: vi.fn() }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));

const { setTeamPeople } = await import("@/state/team-people");
const { AccessOverview } = await import("./AccessOverview");
const { AskToChat } = await import("./AskToChat");

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member" };
const CARA = { email: "cara@acme.test", name: "Cara", role: "member" };
const DAN = { email: "dan@acme.test", name: "Dan", role: "member" };
const bot = (fields: Partial<Bot>): Bot => ({
  id: "x", threadId: "t", name: "X", title: "", description: "", notifications: true, color: "teal", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, yourAccess: "edit", createdBy: ADA.email, ...fields,
});
const payroll = bot({ id: "payroll", name: "Payroll", reportsTo: CARA.email, access: { everyone: "none", people: { [BOB.email]: "view" } } });
const helpdesk = bot({ id: "helpdesk", name: "Helpdesk", access: { everyone: "chat", people: {} } });
const bobsOwn = bot({ id: "bobs", name: "MausBot", defaultBot: { person: BOB.email } });

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (node: ReturnType<typeof createElement>) => flushSync(() => root.render(node));
const overview = async () => { render(createElement(AccessOverview)); await settle(); };
const botRows = () => [...document.querySelectorAll<HTMLElement>("[data-access-row]")];
const summaryOf = (id: string) => document.querySelector(`[data-access-row="${id}"] [data-access-summary]`)!.textContent;
const search = async (text: string) => {
  const field = document.querySelector<HTMLInputElement>("[data-access-search]")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
};
const byPerson = async () => {
  document.querySelector<HTMLElement>('[data-access-listing="person"]')!.click();
  await settle();
};
const openPerson = async (email: string) => {
  document.querySelector<HTMLElement>(`[data-access-person="${email}"]`)!.click();
  await settle();
};
const choose = async (label: string, key: string) => {
  document.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!.click();
  await settle();
  document.querySelector<HTMLElement>(`[role="menu"] [data-menu-key="${key}"]`)!.click();
  await settle();
};

beforeEach(() => {
  server.calls.length = 0;
  server.bots = [payroll, helpdesk, bobsOwn];
  server.answer = {};
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB, CARA, DAN], me: { ...ADA, you: true }, admin: true, needsYou: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  setTeamPeople(null);
});

it("lists each team bot once with its owner and a plain summary, leaving out each person's own MausBot", async () => {
  await overview();
  expect(botRows().map((row) => row.dataset.accessRow)).toEqual(["helpdesk", "payroll"]);
  expect(document.querySelector('[data-access-row="payroll"]')!.textContent).toContain("Owner: Cara");
  expect(summaryOf("payroll")).toBe("Only people added");
  expect(summaryOf("helpdesk")).toBe("Everyone can chat");
  expect(document.querySelector("[data-access-overview] table, [data-access-overview] select")).toBeNull();
});

it("says a bot nobody owns has no owner yet", async () => {
  server.bots = [bot({ id: "orphan", name: "Orphan", createdBy: undefined, access: { everyone: "view", people: {} } })];
  await overview();
  expect(document.querySelector('[data-access-row="orphan"]')!.textContent).toContain("No owner yet");
  expect(summaryOf("orphan")).toBe("Everyone can view");
});

it("stacks up to four faces of those with their own access, then +N, naming them all", async () => {
  const people = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((name) => [`${name}@acme.test`, "chat" as const]));
  server.bots = [bot({ id: "many", name: "Many", access: { everyone: "none", people: { ...people, [ADA.email]: "edit" } } })];
  await overview();
  const stack = document.querySelector<HTMLElement>("[data-access-stack]")!;
  expect(stack.dataset.accessStack).toBe("6");
  expect(stack.children).toHaveLength(5);
  expect(stack.lastElementChild!.textContent).toBe("+2");
  expect(stack.getAttribute("aria-label")).toBe("a@acme.test, b@acme.test, c@acme.test, d@acme.test, e@acme.test, f@acme.test");
});

it("opens the bot's Share dialog from its row, and a change there applies at once with Undo", async () => {
  await overview();
  document.querySelector<HTMLElement>('[data-access-row="payroll"]')!.click();
  await settle();
  expect(document.querySelector("[data-share-bot]")!.getAttribute("data-share-bot")).toBe("payroll");
  await choose("What Bob can do", "edit");
  expect(server.calls.at(-1)).toEqual({ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [BOB.email]: "edit" } } });
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Bob · Can edit");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls.at(-1)).toEqual({ path: "/api/bots/payroll/access", body: payroll.access });
});

it("searches bots by name and by owner, and says when nothing matches", async () => {
  await overview();
  await search("help");
  expect(botRows().map((row) => row.dataset.accessRow)).toEqual(["helpdesk"]);
  await search("cara");
  expect(botRows().map((row) => row.dataset.accessRow)).toEqual(["payroll"]);
  await search("zzz");
  expect(botRows()).toEqual([]);
  expect(document.querySelector("[data-access-overview]")!.textContent).toContain("No bot matches");
});

it("lists every User by person with how many bots they have, and the search follows", async () => {
  await overview();
  await byPerson();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-access-person]")];
  expect(rows.map((row) => row.dataset.accessPerson)).toEqual([BOB.email, CARA.email, DAN.email]);
  expect(rows[0]!.textContent).toContain("2 bots");
  expect(rows[2]!.textContent).toContain("1 bot");
  await search("dan@");
  expect([...document.querySelectorAll<HTMLElement>("[data-access-person]")].map((row) => row.dataset.accessPerson)).toEqual([DAN.email]);
  await search("zzz");
  expect(document.querySelector("[data-access-overview]")!.textContent).toContain("Nobody in the team matches");
});

it("shows a person's bots with the same level menus and Remove, Undo after each, and goes back to their row", async () => {
  await overview();
  await byPerson();
  await openPerson(BOB.email);
  expect([...document.querySelectorAll<HTMLElement>("[data-access-person-bot]")].map((row) => row.dataset.accessPersonBot)).toEqual(["helpdesk", "payroll"]);
  expect(document.querySelector('button[aria-label="What Bob can do with Payroll"]')!.textContent).toBe("Can view");
  await choose("What Bob can do with Payroll", "edit");
  expect(server.calls.at(-1)).toEqual({ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [BOB.email]: "edit" } } });
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Payroll: Bob · Can edit");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls.at(-1)!.body).toEqual(payroll.access);
  await choose("What Bob can do with Payroll", "remove");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: {} });
  expect(document.querySelector("[data-access-toast]")!.textContent).toContain("Payroll: removed Bob");
  document.querySelector<HTMLElement>("[data-access-back]")!.click();
  await settle();
  expect(document.activeElement).toBe(document.querySelector(`[data-access-person="${BOB.email}"]`));
});

it("offers no Remove for access that comes from everyone, nothing below it, and says Owner on the bots they own", async () => {
  await overview();
  await byPerson();
  await openPerson(BOB.email);
  expect(document.querySelector('[data-access-person-bot="helpdesk"]')!.textContent).toContain("Everyone in Acme");
  document.querySelector<HTMLElement>('button[aria-label="What Bob can do with Helpdesk"]')!.click();
  await settle();
  const keys = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [data-menu-key]')];
  expect(keys.map((row) => row.dataset.menuKey)).toEqual(["view", "chat", "edit"]);
  expect(keys.filter((row) => row.disabled).map((row) => row.dataset.menuKey)).toEqual(["view"]);
  document.querySelector<HTMLElement>("[data-access-back]")!.click();
  await settle();
  await openPerson(CARA.email);
  const owned = document.querySelector('[data-access-person-bot="payroll"]')!;
  expect(owned.textContent).toContain("Owner");
  expect(owned.querySelector("button")).toBeNull();
});

it("says so when there are no bots, nobody but admins, or a person with no bots", async () => {
  server.bots = [];
  await overview();
  expect(document.querySelector("[data-access-overview]")!.textContent).toContain("There are no team bots yet.");
  await byPerson();
  await openPerson(BOB.email);
  expect(document.querySelector("[data-access-overview]")!.textContent).toContain("Bob has no bots yet.");
  document.querySelector<HTMLElement>("[data-access-back]")!.click();
  await settle();
  setTeamPeople({ people: [{ ...ADA, you: true }], me: { ...ADA, you: true }, admin: true, needsYou: [] });
  await settle();
  expect(document.querySelector("[data-access-overview]")!.textContent).toContain("Nobody but admins is on the team yet.");
});

it("asks the bot's owner by name, then says it asked", async () => {
  server.answer = { asked: [{ email: CARA.email, name: "Cara" }] };
  render(createElement(AskToChat, { bot: payroll }));
  const button = host.querySelector<HTMLButtonElement>("[data-ask-to-chat]")!;
  expect(button.textContent).toBe("Ask Cara to chat");
  button.click();
  await settle();
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/access-request", body: {} }]);
  expect(host.querySelector('[data-ask-to-chat="asked"]')!.textContent).toBe("Asked Cara");
});

it("asks the admins when nobody on the team owns the bot", () => {
  render(createElement(AskToChat, { bot: bot({ id: "orphan", createdBy: "gone@acme.test" }) }));
  expect(host.querySelector("[data-ask-to-chat]")!.textContent).toBe("Ask an admin to chat");
});
