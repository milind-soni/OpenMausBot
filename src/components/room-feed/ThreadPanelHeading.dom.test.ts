// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Group, GroupTask } from "@/state/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), find: vi.fn() }));
vi.mock("@/state/api", async (original) => ({ ...(await original<typeof import("@/state/api")>()), api: vi.fn(() => new Promise(() => {})) }));
vi.mock("@/lib/chat-find", async (original) => ({ ...(await original<typeof import("@/lib/chat-find")>()), requestChatFind: fixture.find }));
vi.mock("@/state/store", async (original) => {
  const real = await original<typeof import("@/state/store")>();
  return { ...real, useStore: () => ({ state: { ...real.initialState, config: { rooms: { turnTimeoutMinutes: 5 } } }, dispatch: fixture.dispatch }) };
});
vi.mock("@/state/store-ref", () => ({ useStoreRef: () => ({ dispatch: fixture.dispatch, state: () => ({}) }) }));

const { ThreadPanelHeading } = await import("./ThreadPanelHeading");

const task: GroupTask = { threadId: "side", title: "Logo files", createdAt: 2, turnTimeoutMinutes: 60 };
const group = { id: "room", name: "Launch room", threadId: "current", memberIds: [], messages: [], bulletin: "", unread: false, createdAt: 1,
  defaultResponder: { kind: "auto" }, tasks: [{ threadId: "current", title: "", createdAt: 1 }, task] } as unknown as Group;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; fixture.dispatch.mockClear(); fixture.find.mockClear(); });
const show = (work?: { kind: "needs" | "done"; label: string }) => {
  root = createRoot(document.body.appendChild(document.createElement("header")));
  act(() => root!.render(createElement(ThreadPanelHeading, { group, task, messages: [], working: false, work })));
};
const open = () => {
  show();
  act(() => document.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
};
const menuItem = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("[data-thread-overlay] button")].find((button) => button.textContent?.trim() === label);

describe("the heading of a room thread beside its feed", () => {
  it("says where its piece of work stands after the room's name, and nothing for a thread that is not one", () => {
    show({ kind: "needs", label: "Needs Mira" });
    expect(document.querySelector("header p")!.textContent).toBe("Launch room · Needs Mira");
    expect(document.querySelector("[data-thread-work]")?.getAttribute("data-thread-work")).toBe("needs");
    act(() => root!.unmount());
    show();
    expect(document.querySelector("header p")!.textContent).toBe("Launch room");
    expect(document.querySelector("[data-thread-work]")).toBeNull();
  });
});

describe("the menu of a room thread beside its feed", () => {
  it("finds in that thread, not the room's current one", () => {
    open();
    act(() => menuItem("Find in conversation")!.click());
    expect(fixture.find).toHaveBeenCalledWith("side");
  });

  it("sets that thread's time per turn, showing the one it has", () => {
    open();
    expect(menuItem("60 minutes")!.getAttribute("aria-pressed")).toBe("true");
    act(() => menuItem("120 minutes")!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "setConversationTurnLimit", groupId: "room", threadId: "side", minutes: 120, dm: false });
  });
});
