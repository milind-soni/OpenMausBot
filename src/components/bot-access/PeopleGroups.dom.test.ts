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
const { AccessOverview, cellLevel } = await import("./AccessOverview");
const { withGroup } = await import("./access");

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

it("shows a member what their group gives, and adds and removes people from a group", async () => {
  flushSync(() => root.render(createElement(AccessOverview)));
  await settle();
  const cell = (name: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${name} on Payroll"], [data-access-cell="${name}"] select`);
  expect(cell(BOB.email)?.value).toBe("chat");
  expect(cell(CARA.email)?.value).toBe("none");
  expect(document.querySelector(`[data-people-group="finance"] [data-group-member="${BOB.email}"]`)).not.toBeNull();

  const add = document.querySelector<HTMLSelectElement>('select[aria-label="Add someone to Finance…"]')!;
  add.value = CARA.email;
  add.dispatchEvent(new Event("change", { bubbles: true }));
  await settle();
  expect(server.calls.at(-1)).toEqual({ path: "/api/team/groups/finance", method: "PUT", body: { name: "Finance", members: [BOB.email, CARA.email] } });
  expect(cell(CARA.email)?.value, "Cara now has Finance's level").toBe("chat");

  document.querySelector<HTMLButtonElement>('button[aria-label="Remove Bob from Finance"]')!.click();
  await settle();
  expect(server.calls.at(-1)?.body).toEqual({ name: "Finance", members: [CARA.email] });
});

it("works out each level from everyone, the person's own entry and their groups, and adds or removes a group's grant", () => {
  const access = { everyone: "view" as const, people: { [CARA.email]: "edit" as const }, groups: { finance: "chat" as const } };
  const members = (id: string) => (id === "finance" ? [BOB.email, CARA.email] : undefined);
  expect(cellLevel(access, BOB.email, members)).toBe("chat");
  expect(cellLevel(access, CARA.email, members)).toBe("edit");
  expect(cellLevel(access, "dan@acme.test", members)).toBe("view");
  expect(withGroup(access, "finance", null)).toEqual({ everyone: "view", people: { [CARA.email]: "edit" } });
  expect(withGroup({ everyone: "none", people: {} }, "ops", "view")).toEqual({ everyone: "none", people: {}, groups: { ops: "view" } });
});
