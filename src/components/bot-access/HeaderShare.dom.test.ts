// @vitest-environment happy-dom
// Who a team bot is shared with, at the top right of its chat header beside Share: the faces of the people added for
// someone who can edit it, one "Everyone in Acme" mark when everyone can use it, nothing for a bot only its owner uses,
// and for someone who can only chat never more than the server sent them. Each mark opens the Share dialog.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const server = vi.hoisted(() => ({ team: true }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: vi.fn(async () => ({ bot: {} })),
  useStore: () => ({ state: { config: server.team ? { team: { id: "team-acme", name: "Acme" } } : {} }, dispatch: vi.fn() }),
}));

const { setTeamPeople } = await import("@/state/team-people");
const { HeaderShare, sharedWith } = await import("./HeaderShare");

const RUI = { email: "rui@acme.test", name: "Rui", role: "admin" };
const MEMBERS = ["Marta", "Bob", "Cara", "Dan", "Eve"].map((name) => ({ email: `${name.toLowerCase()}@acme.test`, name, role: "member" }));
const [MARTA, BOB, CARA, DAN, EVE] = MEMBERS as [typeof RUI, typeof RUI, typeof RUI, typeof RUI, typeof RUI];
const quotes = (fields: Partial<Bot>): Bot => ({
  id: "quotes", threadId: "t-main", name: "Quotes", title: "", description: "", notifications: true, color: "teal", unread: false,
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, messages: [], createdBy: RUI.email, ...fields,
});
const only = (...people: Array<{ email: string }>) => ({ everyone: "none" as const, people: Object.fromEntries(people.map((person) => [person.email, "chat" as const])) });

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const render = (bot: Bot) => flushSync(() => root.render(createElement(HeaderShare, { bot })));
const wide = () => host.querySelector<HTMLElement>("[data-access-stack]");
const faces = () => [...(wide()?.querySelectorAll<HTMLButtonElement>("[data-access-face]") ?? [])];
const marker = () => host.querySelector<HTMLButtonElement>("[data-shared-with-marker]");
const dialog = () => document.querySelector<HTMLElement>("[data-share-bot]");

beforeEach(() => {
  server.team = true;
  setTeamPeople({ people: [{ ...RUI, you: true }, ...MEMBERS], me: { ...RUI, you: true }, admin: true, needsYou: [] });
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

it("a bot only its owner uses shows Share and nobody", () => {
  render(quotes({ yourAccess: "edit", access: only() }));
  expect(host.querySelector("[data-header-share]")?.getAttribute("data-header-share")).toBe("private");
  expect(wide()).toBeNull();
  expect(marker()).toBeNull();
  expect(host.querySelector("[data-share-bot-button]")).not.toBeNull();
  render(quotes({ yourAccess: "edit", access: only(RUI) }));
  expect(wide(), "its owner is not someone it is shared with").toBeNull();
});

it("shared with people: their faces, each named, a few and then +N; any of them opens Share", async () => {
  render(quotes({ yourAccess: "edit", access: only(MARTA) }));
  expect(faces().map((face) => [face.title, face.getAttribute("aria-label")])).toEqual([["Marta", "Marta"]]);
  expect(wide()!.querySelector("[data-access-more]")).toBeNull();

  render(quotes({ yourAccess: "edit", access: only(MARTA, BOB, CARA, DAN, EVE) }));
  expect(faces().map((face) => face.title)).toEqual(["Marta", "Bob", "Cara"]);
  const more = wide()!.querySelector<HTMLButtonElement>("[data-access-more]")!;
  expect(more.textContent).toBe("+2");
  expect(more.title, "the rest are named there").toBe("Dan, Eve");
  expect(wide()!.getAttribute("aria-label")).toBe("Marta, Bob, Cara, Dan, Eve");
  const narrow = host.querySelectorAll<HTMLElement>("[data-access-stack]")[1]!;
  expect(narrow.textContent, "a narrow header folds them into one count").toBe("+5");
  expect(narrow.querySelector("[data-access-face]")).toBeNull();

  expect(dialog()).toBeNull();
  faces()[1]!.click();
  await settle();
  expect(dialog()?.getAttribute("data-share-bot")).toBe("quotes");
});

it("shared with everyone: one mark that says so, never faces", async () => {
  render(quotes({ yourAccess: "edit", access: { everyone: "chat", people: { [MARTA.email]: "edit" } } }));
  expect(wide()).toBeNull();
  expect([marker()!.title, marker()!.getAttribute("aria-label"), marker()!.dataset.sharedWithMarker]).toEqual(["Everyone in Acme", "Everyone in Acme", "everyone"]);
  marker()!.click();
  await settle();
  expect(dialog()).not.toBeNull();
});

it("someone who can only chat or view sees that it is shared, never who with", () => {
  const sent = { yourAccess: "chat" as const, createdBy: RUI.email };
  render(quotes({ ...sent, onlyPeopleAdded: true }));
  expect(wide()).toBeNull();
  expect([marker()!.title, marker()!.dataset.sharedWithMarker]).toEqual(["Only people added", "added"]);
  expect(host.textContent).not.toContain("Marta");
  render(quotes({ ...sent }));
  expect(marker()!.title).toBe("Everyone in Acme");
  expect(sharedWith({ yourAccess: "view", onlyPeopleAdded: true, access: only(MARTA, BOB) } as never), "even a list that should never have been sent is not read").toEqual({ kind: "added" });
});

it("shows nothing off a team or on a person's own MausBot", () => {
  render(quotes({ yourAccess: "edit", access: only(MARTA), defaultBot: { person: RUI.email } }));
  expect(host.innerHTML).toBe("");
  server.team = false;
  render(quotes({ yourAccess: "edit", access: only(MARTA) }));
  expect(host.innerHTML).toBe("");
});
