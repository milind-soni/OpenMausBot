// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { bots: [] as unknown[], groups: [] as unknown[] }, dispatch: vi.fn(), api: vi.fn(), admin: null as boolean | null }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: fixture.api,
}));

vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));

const { TeamMenuItems } = await import("./SidebarTeamMenu");

let root: Root;
let host: HTMLElement;
const onRead = vi.fn();
const noop = () => {};
const render = (department?: string) => flushSync(() => root.render(createElement(TeamMenuItems, {
  ...(department !== undefined ? { department } : {}), onRead, onAddBots: noop, onRename: noop, onShare: noop, onDelete: noop,
})));
const markRead = () => host.querySelector<HTMLButtonElement>("[data-team-mark-read]");
const settle = () => new Promise((done) => setTimeout(done, 0));
const opsBot = (id: string, unread: boolean) => ({ id, threadId: `${id}-main`, section: "Ops", unread, tasks: [{ threadId: `${id}-main`, title: "Main", createdAt: 0, unread }] });

beforeEach(() => {
  fixture.dispatch.mockReset();
  fixture.api.mockReset();
  fixture.admin = null;
  onRead.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); });

describe("a department's Mark all as read", () => {
  it("is offered only while something in the department is unread", () => {
    fixture.state = { bots: [opsBot("ada", false)], groups: [{ id: "standup", unread: false, section: "Ops" }] };
    render("Ops");
    expect(markRead()).toBeNull();
    fixture.state = { bots: [opsBot("ada", true)], groups: [] };
    render("Ops");
    expect(markRead()?.textContent).toBe("Mark all as read");
    render();
    expect(markRead()).toBeNull();
  });

  it("reads the department's bots and group chats, updates the sidebar and closes the menu", async () => {
    fixture.state = { bots: [opsBot("ada", true)], groups: [{ id: "standup", unread: true, section: "Ops" }] };
    fixture.api.mockImplementation(async (path: string) => path.startsWith("/api/groups/") ? { group: { id: "standup", unread: false } } : { bot: { id: "ada" } });
    render("Ops");
    flushSync(() => markRead()!.click());
    await settle();
    expect(fixture.api.mock.calls.map(([path]) => path)).toEqual(["/api/bots/ada/read", "/api/groups/standup/read"]);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "botPatched", bot: { id: "ada" } });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "groupPatched", group: { id: "standup", unread: false } });
    expect(onRead).toHaveBeenCalled();
  });

  it("says so when a read fails, and keeps the menu open", async () => {
    fixture.state = { bots: [opsBot("ada", true)], groups: [] };
    fixture.api.mockRejectedValue(new Error("offline"));
    render("Ops");
    flushSync(() => markRead()!.click());
    await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "error", message: expect.stringContaining("offline") });
    expect(onRead).not.toHaveBeenCalled();
  });
});

describe("a department's menu", () => {
  const full = (extra: Partial<Parameters<typeof TeamMenuItems>[0]> = {}) => flushSync(() => root.render(createElement(TeamMenuItems, {
    department: "Ops", onRead, onAddBots: noop, onRename: noop, onShare: noop, onDelete: noop, onSetForAll: noop, ...extra,
  })));
  const rows = () => [...host.children].map((node) => node.getAttribute("role") === "separator" ? "—" : node.textContent);

  it("lists its actions in order, with Delete set apart at the end", () => {
    fixture.admin = true;
    fixture.state = { bots: [opsBot("ada", true)], groups: [] };
    full();
    expect(rows()).toEqual(["Add bots", "Rename department", "Settings for all bots…", "Pause department", "Mark all as read", "Share", "—", "Delete department"]);
  });

  it("offers Move up and Move down only when the caller passes them", () => {
    fixture.state = { bots: [], groups: [] };
    full();
    expect(host.querySelector("[data-team-move-up], [data-team-move-down]")).toBeNull();
    expect(host.textContent).not.toMatch(/Move (up|down)/);
    full({ onMoveUp: noop, onMoveDown: noop });
    expect(rows()).toEqual(["Add bots", "Rename department", "Settings for all bots…", "Share", "Move up", "Move down", "—", "Delete department"]);
  });

  it("never lets a long label squeeze out an item's icon", () => {
    fixture.admin = true;
    fixture.state = { bots: [opsBot("ada", true)], groups: [] };
    full();
    const items = [...host.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
    expect(items.length).toBe(7);
    for (const item of items) {
      expect(item.className.split(" ")).toContain("[&>svg]:shrink-0");
      expect(item.querySelector(":scope > svg")).not.toBeNull();
      expect(item.querySelector(":scope > span")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    }
    expect(host.querySelector("[data-team-settings] > svg")).not.toBeNull();
  });
});
