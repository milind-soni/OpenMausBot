// @vitest-environment happy-dom
// Settings → Bot access with the team's groups: a member's cell shows what their group gives, and the groups editor
// makes, fills and empties a group through the server.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";

const server = vi.hoisted(() => ({ calls: [] as Array<{ path: string; method: string; body: unknown }>, groups: [] as Array<{ id: string; name: string; members: string[] }> }));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  useStore: () => ({ state: { config: { team: { id: "team-acme", name: "Acme" } }, bots: [payroll] }, dispatch: vi.fn() }),
  api: vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { name: string; members: string[] } : undefined;
    server.calls.push({ path, method: init?.method ?? "GET", body });
    if (init?.method === "PUT" && body) server.groups = server.groups.map((group) => (path.endsWith(group.id) ? { ...group, ...body } : group));
    if (init?.method === "POST" && body) server.groups = [...server.groups, { id: "g-new", ...body }];
    return { groups: server.groups, group: server.groups.at(-1) };
  }),
}));
vi.mock("../Avatar", () => ({ BotAvatar: () => null }));

const { setTeamPeople } = await import("@/state/team-people");
const { AccessOverview } = await import("./AccessOverview");
const { floorFor, withGroup } = await import("./access");

const ADA = { email: "ada@acme.test", name: "Ada", role: "admin" };
const BOB = { email: "bob@acme.test", name: "Bob", role: "member" };
const CARA = { email: "cara@acme.test", name: "Cara", role: "member" };
const payroll = {
  id: "payroll", threadId: "t", name: "Payroll", title: "", description: "", notifications: true, color: "teal", unread: false, messages: [],
  modelSelection: { instanceId: "claude", model: "claude-opus-5-5" }, yourAccess: "edit", createdBy: ADA.email,
  access: { everyone: "none", people: {}, groups: { finance: "chat" } },
} as unknown as Bot;

let host: HTMLDivElement;
let root: Root;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

beforeEach(() => {
  server.calls.length = 0;
  server.groups = [{ id: "finance", name: "Finance", members: [BOB.email] }];
  setTeamPeople({ people: [{ ...ADA, you: true }, BOB, CARA], me: { ...ADA, you: true }, admin: true, needsYou: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  setTeamPeople(null);
});

it("shows a person the bots their group gives them, and adds and removes people from a group", async () => {
  flushSync(() => root.render(createElement(AccessOverview)));
  await settle();
  expect(document.querySelector(`[data-people-group="finance"] [data-group-member="${BOB.email}"]`)).not.toBeNull();

  document.querySelector<HTMLElement>('[data-access-listing="person"]')!.click();
  await settle();
  const count = (email: string) => document.querySelector<HTMLElement>(`[data-access-person="${email}"]`)?.textContent ?? "";
  expect(count(BOB.email)).toContain("1 bot");
  document.querySelector<HTMLElement>(`[data-access-person="${BOB.email}"]`)!.click();
  await settle();
  expect(document.querySelector('[data-access-person-bot="payroll"]')?.textContent).toContain("Through Finance");
  document.querySelector<HTMLElement>("[data-access-back]")!.click();
  await settle();

  const add = document.querySelector<HTMLSelectElement>('select[aria-label="Add someone to Finance…"]')!;
  add.value = CARA.email;
  add.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(server.calls.at(-1)).toEqual({ path: "/api/team/groups/finance", method: "PUT", body: { name: "Finance", members: [BOB.email, CARA.email] } });

  document.querySelector<HTMLButtonElement>('button[aria-label="Remove Bob from Finance"]')!.click();
  await settle();
  expect(server.calls.at(-1)?.body).toEqual({ name: "Finance", members: [CARA.email] });
});

it("finds the least a person has from everyone and their groups, and adds or removes a group's grant", () => {
  const access = { everyone: "view" as const, people: { [CARA.email]: "edit" as const }, groups: { finance: "chat" as const } };
  const members = (id: string) => (id === "finance" ? [BOB.email, CARA.email] : undefined);
  expect(floorFor(access, BOB.email, members)).toEqual({ level: "chat", group: "finance" });
  expect(floorFor(access, "dan@acme.test", members)).toEqual({ level: "view" });
  expect(withGroup(access, "finance", null)).toEqual({ everyone: "view", people: { [CARA.email]: "edit" } });
  expect(withGroup({ everyone: "none", people: {} }, "ops", "view")).toEqual({ everyone: "none", people: {}, groups: { ops: "view" } });
});
