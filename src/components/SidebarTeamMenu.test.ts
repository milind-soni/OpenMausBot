// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { bots: [] as unknown[], groups: [] as unknown[] }, dispatch: vi.fn(), api: vi.fn() }));
vi.mock("@/state/store", async (original) => ({
  ...await original<typeof import("@/state/store")>(),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
  api: fixture.api,
}));

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
