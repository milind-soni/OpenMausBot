// @vitest-environment happy-dom
// A team bot's Share dialog in a real DOM: whether everyone in the team can use the bot or only the people added, adding
// a teammate from the keyboard, a change applied at once with its Undo, handing the bot on, and what someone who can't
// edit the bot is shown. A person's stored level is kept, never shown.
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

it("lists who looks after it first as quiet text, then each person added with no level shown, and what everyone in the team gets", async () => {
  await open(editable);
  expect([...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"))).toEqual([ADA.email, BOB.email, CARA.email]);
  const owner = dialog()!.querySelector(`[data-share-person="${ADA.email}"]`)!;
  expect(owner.textContent).toContain("Ada (you)");
  expect(owner.textContent).toContain("Looks after it");
  expect(owner.querySelector("button")).toBeNull();
  expect(menuOf("Bob's access").textContent).toBe("Added");
  expect(dialog()!.textContent).not.toContain("Can view");
  expect(dialog()!.textContent).not.toContain("Can edit");
  expect(dialog()!.querySelector("select")).toBeNull();
  expect(dialog()!.querySelector("[data-share-general]")!.getAttribute("data-share-general")).toBe("none");
  expect(dialog()!.textContent).toContain("Admins can always edit every bot.");
});

it("opens a person's real menu: have them look after it, then a divider and Remove access, and no levels", async () => {
  await open(editable);
  await openMenu("Bob's access");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["owner", "remove"]);
  expect(rows().map((row) => row.getAttribute("role"))).toEqual(["menuitem", "menuitem"]);
  expect(rows()[0]!.textContent).toBe("Have Bob look after it");
  expect(document.querySelectorAll('[role="menu"] [role="separator"]')).toHaveLength(1);
  expect(rows()[1]!.parentElement!.querySelector('[role="separator"]')).not.toBeNull();
});

it("removes a person at once, says so with Undo, and Undo puts the sharing back with their stored level", async () => {
  await open(editable);
  await choose("Bob's access", "remove");
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/access", body: { everyone: "none", people: { [CARA.email]: "chat" } } }]);
  const toast = document.querySelector<HTMLElement>("[data-access-toast]")!;
  expect(toast.textContent).toContain("Removed Bob");
  toast.querySelector("button")!.click();
  await settle();
  expect(server.calls[1]).toEqual({ path: "/api/bots/payroll/access", body: editable.access });
  expect(document.querySelector("[data-access-toast]")).toBeNull();
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
  expect(document.querySelector("[data-access-toast]")!.textContent).toContain("Added Eve");
  expect(document.querySelector("[data-access-toast]")!.textContent).not.toContain("Can chat");
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

it("removes a person, and switches between everyone in the team using it and only people added, from quiet menus", async () => {
  await open(editable);
  await choose("Cara's access", "remove");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: { [BOB.email]: "view" } });
  await choose("General access", "everyone");
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "chat", people: editable.access!.people });
  expect(document.querySelector("[data-access-toast]")!.textContent).toContain("Everyone in Acme can use it now");
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await open(payroll({ yourAccess: "edit", access: { everyone: "chat", people: {} } }));
  expect(dialog()!.textContent).toContain("Everyone in Acme can find it and chat with it.");
  expect(menuOf("General access").textContent).toBe("Everyone in Acme can use it");
  expect(document.querySelector('[data-share-bot] button[aria-label="What everyone in Acme can do"]'), "no level for everyone on a team").toBeNull();
  await openMenu("General access");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["none", "everyone"]);
  rows()[0]!.click();
  await settle();
  expect(server.calls.at(-1)!.body).toEqual({ everyone: "none", people: {} });
});

it("hands the bot to someone added only after a confirmation", async () => {
  await open(editable);
  await choose("Bob's access", "owner");
  expect(server.calls).toEqual([]);
  expect(dialog()!.querySelector(`[data-share-make-owner="${BOB.email}"]`)!.textContent).toContain("Have Bob look after Payroll?");
  expect(document.activeElement?.textContent).toBe("Cancel");
  await press("Escape");
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
  expect(dialog()).not.toBeNull();
  await choose("Bob's access", "owner");
  [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Have Bob look after it")!.click();
  await settle();
  expect(server.calls).toEqual([{ path: "/api/bots/payroll/reports-to", body: { email: BOB.email } }]);
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
});

it("stays on the confirmation and says why when the handover is refused", async () => {
  await open(editable);
  await choose("Bob's access", "owner");
  server.refuse = "Bob is no longer in the team";
  [...dialog()!.querySelectorAll("button")].find((button) => button.textContent === "Have Bob look after it")!.click();
  await settle();
  expect(dialog()!.querySelector("[data-share-make-owner]")!.querySelector('[role="alert"]')!.textContent).toBe("Bob is no longer in the team");
  dialog()!.focus();
  await press("Escape");
  expect(dialog()!.querySelector("[data-share-make-owner]")).toBeNull();
  expect(dialog()!.querySelector('[role="alert"]')).toBeNull();
});

it("offers the handover only to whoever may hand it on, and never for an address nobody on the team has", async () => {
  setTeamPeople({ people: [ADA, BOB, CARA, { ...DAN, you: true }, EVE], me: { ...DAN, you: true }, admin: false, needsYou: [] });
  await open(payroll({ yourAccess: "edit", access: { everyone: "none", people: { [BOB.email]: "view", [DAN.email]: "edit" } } }));
  await openMenu("Bob's access");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["remove"]);
  flushSync(() => root.unmount());
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB], me: { ...ADA, you: true }, admin: true, needsYou: [] });
  await open(payroll({ yourAccess: "edit", access: { everyone: "none", people: { "@acme.test": "chat" } } }));
  await openMenu("@acme.test's access");
  expect(rows().map((row) => row.dataset.menuKey)).toEqual(["remove"]);
});

it("shows someone who can't edit the same layout read only: themselves with no level, who looks after it and the admins line", async () => {
  setTeamPeople({ people: [ADA, { ...BOB, you: true }], me: { ...BOB, you: true }, admin: false, needsYou: [] });
  await open(payroll({ yourAccess: "view" }));
  expect([...dialog()!.querySelectorAll("[data-share-person]")].map((row) => row.getAttribute("data-share-person"))).toEqual([ADA.email, BOB.email]);
  const yours = dialog()!.querySelector("[data-share-yours]")!;
  expect(yours.textContent).toContain("Bob (you)");
  expect(yours.textContent).not.toContain("Can view");
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
