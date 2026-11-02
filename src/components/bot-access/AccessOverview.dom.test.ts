// @vitest-environment happy-dom
// Settings → Bot access in a real DOM: every team bot by every User, the owner, what everyone gets, a change applied at
// once with Undo; and a viewer's "Ask Ada to chat".
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
const select = (label: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const choose = (label: string, value: string) => {
  const field = select(label);
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  server.calls.length = 0;
  server.bots = [payroll, helpdesk, bobsOwn];
  server.answer = {};
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB, CARA], me: { ...ADA, you: true }, admin: true, needsYou: [] });
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

it("lists each team bot with every User's level and what everyone gets, leaving out each person's own MausBot", () => {
  render(createElement(AccessOverview));
  expect([...document.querySelectorAll("[data-access-row]")].map((row) => row.getAttribute("data-access-row"))).toEqual(["helpdesk", "payroll"]);
  expect(select("Set for everyone: Payroll").value).toBe("none");
  expect(select("What Bob can do with Payroll").value).toBe("view");
  expect(document.querySelector('[data-access-row="payroll"] [data-access-cell="cara@acme.test"]')!.textContent).toBe("Owner");
  expect(select("What Bob can do with Helpdesk").value).toBe("chat");
  expect([...select("What Bob can do with Helpdesk").options].filter((option) => option.disabled).map((option) => option.value)).toEqual(["none", "view"]);
});

it("applies a cell or a whole row at once, with Undo", async () => {
  render(createElement(AccessOverview));
  choose("What Bob can do with Payroll", "edit");
  await settle();
  expect(server.calls.at(-1)).toEqual({ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [BOB.email]: "edit" } } });
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Payroll: Bob · Can edit");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls.at(-1)).toEqual({ path: "/api/bots/payroll/access", body: payroll.access });
  choose("What Bob can do with Payroll", "none");
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: {} });
  choose("Set for everyone: Payroll", "view");
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "view", people: { [BOB.email]: "view" } });
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
