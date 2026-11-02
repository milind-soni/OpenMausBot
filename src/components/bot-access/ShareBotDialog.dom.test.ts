// @vitest-environment happy-dom
// A team bot's Share dialog in a real DOM: who has access at what level, adding a teammate from the keyboard, a change
// applied at once with its Undo, handing the bot on, and what someone who can't edit the bot is shown.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; body: unknown }>, team: true, refuse: "" }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    server.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (server.refuse) throw new Error(server.refuse);
    return { bot: {} };
  }),
  useStore: () => ({ state: { config: server.team ? { team: { id: "team-acme", name: "Acme" } } : {} }, dispatch: vi.fn() }),
}));

const { setTeamPeople } = await import("@/state/team-people");
const { ShareBotButton } = await import("./ShareBotButton");

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member" };
const CARA = { email: "cara@acme.test", name: "Cara", role: "member" };
const DAN = { email: "dan@acme.test", name: "Dan", role: "member" };
const EVE = { email: "eve@acme.test", name: "Eve", role: "member" };
const payroll = (fields: Partial<Bot>): Bot => ({
  id: "payroll", threadId: "t-main", name: "Payroll", title: "", description: "", notifications: true, color: "teal", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: [], createdBy: ADA.email, ...fields,
});
const editable = payroll({ yourAccess: "edit", access: { everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat" } } });

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (bot: Bot, more?: object) => flushSync(() => root.render(createElement(ShareBotButton, { bot, className: "", ...more })));
const dialog = () => document.querySelector<HTMLElement>("[data-share-bot]");
const open = async (bot: Bot, more?: object) => {
  render(bot, more);
  host.querySelector<HTMLButtonElement>("[data-share-bot-button]")!.click();
  await settle();
};
const menuOf = (label: string) => document.querySelector<HTMLButtonElement>(`[data-share-bot] button[aria-label="${label}"]`)!;
const rows = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] [data-menu-key]')];
const openMenu = async (label: string) => { menuOf(label).click(); await settle(); };
const choose = async (label: string, key: string) => {
  await openMenu(label);
  rows().find((row) => row.dataset.menuKey === key)!.click();
  await settle();
};
const field = () => dialog()!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const press = async (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(event);
  await settle();
  return event;
};
const offered = () => [...document.querySelectorAll<HTMLElement>("[data-share-suggestion]")];

beforeEach(() => {
  server.calls.length = 0;
  server.team = true;
  server.refuse = "";
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB, CARA, DAN, EVE], me: { ...ADA, you: true }, admin: true, needsYou: [] });
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

it("lists the owner first as quiet text, then each person added with their level, and what everyone in the team gets", async () => {
  await open(editable);
  expect([...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"))).toEqual([ADA.email, BOB.email, CARA.email]);
  const owner = dialog()!.querySelector(`[data-share-person="${ADA.email}"]`)!;
  expect(owner.textContent).toContain("Ada (you)");
  expect(owner.textContent).toContain("Owner");
  expect(owner.querySelector("button")).toBeNull();
  expect(menuOf("What Bob can do").textContent).toBe("Can view");
  expect(dialog()!.querySelector("select")).toBeNull();
  expect(dialog()!.querySelector("[data-share-general]")!.getAttribute("data-share-general")).toBe("none");
  expect(dialog()!.textContent).toContain("Admins can always edit every bot.");
});

it("opens a level on a real menu: each level on two lines, a check on the current one, then a divider and Remove access", async () => {
  await open(editable);
  await openMenu("What Bob can do");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["view", "chat", "edit", "owner", "remove"]);
  expect(rows().map((row) => row.getAttribute("role"))).toEqual(["menuitemradio", "menuitemradio", "menuitemradio", "menuitem", "menuitem"]);
  expect(rows()[0]!.textContent).toBe("Can viewRead its shared conversations");
  expect(rows().filter((row) => row.getAttribute("aria-checked") === "true").map((row) => row.dataset.menuKey)).toEqual(["view"]);
  expect(rows()[0]!.querySelector("svg")).not.toBeNull();
  expect(rows()[1]!.querySelector("svg")).toBeNull();
  expect(document.querySelectorAll('[role="menu"] [role="separator"]')).toHaveLength(1);
  expect(rows()[3]!.parentElement!.querySelector('[role="separator"]')).not.toBeNull();
});

it("offers nothing below what everyone already gets", async () => {
  await open(payroll({ yourAccess: "edit", access: { everyone: "chat", people: { [BOB.email]: "edit" } } }));
  await openMenu("What Bob can do");
  expect(rows().filter((row) => row.disabled).map((row) => row.dataset.menuKey)).toEqual(["view"]);
});

it("applies a change at once, says so with Undo, and Undo puts the sharing back", async () => {
  await open(editable);
  await choose("What Bob can do", "edit");
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [BOB.email]: "edit", [CARA.email]: "chat" } } }]);
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Bob · Can edit");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls[1]).toEqual({ path: "/api/bots/payroll/access", body: editable.access });
  expect(document.querySelector("[data-access-toast]")).toBeNull();
});

it("sends nothing when the current level is chosen again", async () => {
  await open(editable);
  await choose("What Bob can do", "view");
  expect(server.calls).toEqual([]);
});

it("suggests teammates not yet added, and arrow keys and Enter add one at Can chat with Undo", async () => {
  await open(editable);
  field().focus();
  await settle();
  expect(offered().map((row) => row.dataset.shareSuggestion)).toEqual([DAN.email, EVE.email]);
  expect(offered()[0]!.textContent).toContain("dan@acme.test");
  expect(field().getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(field().getAttribute("aria-activedescendant")!)!.dataset.shareSuggestion).toBe(DAN.email);
  await press("ArrowDown");
  expect(document.getElementById(field().getAttribute("aria-activedescendant")!)!.dataset.shareSuggestion).toBe(EVE.email);
  await press("ArrowDown");
  await press("ArrowUp");
  expect(offered().find((row) => row.getAttribute("aria-selected") === "true")!.dataset.shareSuggestion).toBe(EVE.email);
  await press("Enter");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: { [BOB.email]: "view", [CARA.email]: "chat", [EVE.email]: "chat" } });
  expect(document.querySelector("[data-access-toast]")!.textContent).toContain("Added Eve · Can chat");
  expect(offered()).toEqual([]);
  expect(document.activeElement).toBe(field());
});

it("closes the suggestions on Escape first, and the dialog only on the next", async () => {
  await open(editable);
  field().focus();
  await settle();
  await press("Escape");
  expect(offered()).toEqual([]);
  expect(dialog()).not.toBeNull();
  await press("Escape");
  expect(dialog()).toBeNull();
});

it.each([
  ["none", "chat"],
  ["view", "chat"],
  ["chat", "chat"],
] as const)("adds someone at Can chat when everyone gets %s", async (everyone, level) => {
  await open(payroll({ yourAccess: "edit", access: { everyone, people: {} } }));
  field().focus();
  await settle();
  offered()[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone, people: { [BOB.email]: level } });
});

it("has nobody to add when everyone can already edit", async () => {
  await open(payroll({ yourAccess: "edit", access: { everyone: "edit", people: {} } }));
  expect(dialog()!.querySelector('input[role="combobox"]')).toBeNull();
  expect(dialog()!.textContent).toContain("Everyone in the team can already edit it.");
});

it("removes a person, opens the bot to everyone and sets what everyone gets, each from a quiet menu", async () => {
  await open(editable);
  await choose("What Cara can do", "remove");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: { [BOB.email]: "view" } });
  await choose("General access", "everyone");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "chat", people: editable.access!.people });
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await open(payroll({ yourAccess: "edit", access: { everyone: "chat", people: {} } }));
  expect(dialog()!.textContent).toContain("Everyone in Acme can find it and chat with it.");
  await openMenu("What everyone in Acme can do");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["view", "chat", "edit"]);
  rows()[2]!.click();
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "edit", people: {} });
  await choose("General access", "none");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: {} });
});

it("hands the bot to someone added only after a confirmation", async () => {
  await open(editable);
  await choose("What Bob can do", "owner");
  expect(server.calls).toEqual([]);
  expect(dialog()!.querySelector(`[data-share-make-owner="${BOB.email}"]`)!.textContent).toContain("Make Bob the owner?");
  expect(document.activeElement?.textContent).toBe("Cancel");
  await press("Escape");
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
  expect(dialog()).not.toBeNull();
  await choose("What Bob can do", "owner");
  [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Make owner")!.click();
  await settle();
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/reports-to", body: { email: BOB.email } }]);
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
});

it("stays on the confirmation and says why when the handover is refused", async () => {
  await open(editable);
  await choose("What Bob can do", "owner");
  server.refuse = "Bob already has a Chief of Staff";
  [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Make owner")!.click();
  await settle();
  expect(dialog()!.querySelector("[data-share-make-owner]")!.querySelector('[role="alert"]')!.textContent).toBe("Bob already has a Chief of Staff");
  dialog()!.focus();
  await press("Escape");
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
  expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
});

it("offers Make owner only to whoever may hand it on, and never for an address nobody on the team has", async () => {
  setTeamPeople({ people: [ADA, BOB, CARA, { ...DAN, you: true }, EVE], me: { ...DAN, you: true }, admin: false, needsYou: [] });
  await open(payroll({ yourAccess: "edit", access: { everyone: "none", people: { [BOB.email]: "view", [DAN.email]: "edit" } } }));
  await openMenu("What Bob can do");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["view", "chat", "edit", "remove"]);
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB], me: { ...ADA, you: true }, admin: true, needsYou: [] });
  await open(payroll({ yourAccess: "edit", access: { everyone: "none", people: { "@acme.test": "chat" } } }));
  await openMenu("What @acme.test can do");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["view", "chat", "edit", "remove"]);
});

it("shows someone who can't edit the same layout read only: their level, the owner and the admins line", async () => {
  setTeamPeople({ people: [ADA, { ...BOB, you: true }], me: { ...BOB, you: true }, admin: false, needsYou: [] });
  await open(payroll({ yourAccess: "view" }));
  expect([...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"))).toEqual([ADA.email, BOB.email]);
  const yours = dialog()!.querySelector("[data-share-yours]")!;
  expect(yours.textContent).toContain("Bob (you)");
  expect(yours.textContent).toContain("Can view");
  expect(dialog()!.textContent).toContain("Admins can always edit every bot.");
  expect(dialog()!.querySelector("input, select, [data-share-general], [aria-haspopup=menu]")).toBeNull();
});

it("keeps its keys to itself over Settings, which listens on the window, and Escape closes only it", async () => {
  const reached: string[] = [];
  const listen = (event: KeyboardEvent) => { reached.push(event.key); };
  window.addEventListener("keydown", listen);
  try {
    await open(editable);
    field().focus();
    await press("Tab");
    await press("Escape");
    await press("Escape");
  } finally {
    window.removeEventListener("keydown", listen);
  }
  expect(reached).toEqual([]);
  expect(dialog()).toBeNull();
});

it("draws what else its opener offers in the header, with only Done at its foot", async () => {
  await open(editable, { headerMenu: createElement("button", { type: "button", "data-more": true }, "More") });
  expect(dialog()!.querySelector("header [data-more]")).not.toBeNull();
  expect([...dialog()!.querySelectorAll("footer button")].map((button) => button.textContent)).toEqual(["Done"]);
});

it("is not there off a team", () => {
  server.team = false;
  render(editable);
  expect(host.querySelector("[data-share-bot-button]")).toBeNull();
});
