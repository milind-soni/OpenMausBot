// @vitest-environment happy-dom
// A team bot's Share dialog in a real DOM: who has access at what level, adding a teammate, a change applied at once with
// its Undo, and what someone who can't edit the bot is shown.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }>, team: true }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { bot: {} };
  }),
  useStore: () => ({ state: { config: server.team ? { team: { id: "team-acme", name: "Acme" } } : {} }, dispatch: vi.fn() }),
}));

const { setTeamPeople } = await import("@/state/team-people");
const { ShareBotButton } = await import("./ShareBotButton");

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member" };
const CARA = { email: "cara@acme.test", name: "Cara", role: "member" };
const EVE = { email: "eve@acme.test", name: "Eve", role: "member" };
const payroll = (fields: Partial<Bot>): Bot => ({
  id: "payroll", threadId: "t-main", name: "Payroll", title: "", description: "", notifications: true, color: "teal", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: [], createdBy: ADA.email, ...fields,
});
const editable = payroll({ yourAccess: "edit", access: { everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat" } } });

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (bot: Bot) => flushSync(() => root.render(createElement(ShareBotButton, { bot, className: "" })));
const dialog = () => document.querySelector<HTMLElement>("[data-share-bot]");
const open = async (bot: Bot) => {
  render(bot);
  host.querySelector<HTMLButtonElement>("[data-share-bot-button]")!.click();
  await settle();
};
const choose = (label: string, value: string) => {
  const field = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
};

beforeEach(() => {
  server.calls.length = 0;
  server.team = true;
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB, CARA, EVE], me: { ...ADA, you: true }, admin: true, needsYou: [] });
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

it("lists the owner first, then each person added with their level, and what everyone in the team gets", async () => {
  await open(editable);
  const rows = [...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"));
  expect(rows).toEqual([ADA.email, BOB.email, CARA.email]);
  expect(document.querySelector<HTMLSelectElement>('select[aria-label="What Bob can do"]')!.value).toBe("view");
  expect(dialog()!.querySelector("[data-share-general]")!.getAttribute("data-share-general")).toBe("none");
  expect(dialog()!.textContent).toContain("Admins can always edit every bot.");
});

it("applies a change at once, says so with Undo, and Undo puts the sharing back", async () => {
  await open(editable);
  choose("What Bob can do", "edit");
  await settle();
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [BOB.email]: "edit", [CARA.email]: "chat" } } }]);
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Bob · Can edit");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls[1]).toEqual({ path: "/api/bots/payroll/access", body: editable.access });
  expect(document.querySelector("[data-access-toast]")).toBeNull();
});

it("adds a teammate from the team at Can chat, removes one, and opens the bot to everyone", async () => {
  await open(editable);
  const field = dialog()!.querySelector<HTMLInputElement>("input")!;
  field.focus();
  await settle();
  const offered = [...document.querySelectorAll("#share-bot-people [role=option]")].map((row) => row.textContent);
  expect(offered).toEqual([expect.stringContaining("Eve")]);
  document.querySelector<HTMLElement>("#share-bot-people [role=option]")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat", [EVE.email]: "chat" } });
  choose("What Cara can do", "remove");
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: { [BOB.email]: "view" } });
  choose("General access", "everyone");
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "chat", people: editable.access!.people });
});

it("shows someone who can't edit the bot their own level and its owner, never the list or the controls", async () => {
  await open(payroll({ yourAccess: "view" }));
  expect(dialog()!.querySelector("[data-share-yours]")!.textContent).toContain("You can view Payroll");
  expect([...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"))).toEqual([ADA.email]);
  expect(dialog()!.querySelector("input, select, [data-share-general]")).toBeNull();
});

it("is not there off a team", () => {
  server.team = false;
  render(editable);
  expect(host.querySelector("[data-share-bot-button]")).toBeNull();
});
