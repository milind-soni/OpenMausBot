// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";

vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./Sidebar", () => ({
  BotListItem: () => null,
  BotThreadList: ({ bot }: { bot: Bot }) => createElement("div", null, bot.tasks?.map((task) => createElement("div", { key: task.threadId }, task.title))),
}));
import { PinnedBotRoster } from "./PinnedCircleThreads";
import type { BotRowProps } from "./Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bots = ["Atlas", "Beacon", "Comet", "Delta"].map((name): Bot => ({
  id: name, threadId: name, name, title: "", description: "", notifications: true,
  color: "green", unread: false, pinned: true, messages: [],
  modelSelection: { instanceId: "claude", model: "test" },
  tasks: [1, 2].map((n) => ({ threadId: `${name}-${n}`, title: `Report ${n}`, createdAt: n })),
}));
let host: HTMLDivElement;
let root: Root;
let query = "";
let reveal: BotRowProps["reveal"] = null;
const render = () => act(() => root.render(createElement(PinnedBotRoster, {
  bots, density: "comfortable", circles: true, listItem: () => null,
  row: (bot): BotRowProps => ({ bot, selected: false, deleting: false, mascotMotion: null,
    reveal: reveal?.threadId.startsWith(bot.id) ? reveal : null,
    pendingQueued: initialState.pendingQueued, instances: [], liveCall: null,
    locale: "en", generatedTitles: false, density: "comfortable", query, dispatch: vi.fn(), onMenu: vi.fn() }),
})));
const toggle = (name: string) => act(() => host.querySelector<HTMLButtonElement>(`button[aria-controls="pinned-circle-threads-${name}"]`)!.click());
const panels = () => Array.from(host.querySelectorAll("[data-sidebar-pinned-circle-thread-list]"), (node) => node.getAttribute("data-sidebar-pinned-circle-thread-list"));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(180);
  query = "";
  reveal = null;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });

it("replaces a sibling's list, keeps other rows open, and collapses on a second click", () => {
  render();
  toggle("Atlas");
  toggle("Comet");
  expect(panels()).toEqual(["Atlas", "Comet"]);
  toggle("Beacon");
  expect(panels()).toEqual(["Beacon", "Comet"]);
  expect(host.querySelector('[aria-controls="pinned-circle-threads-Atlas"]')?.getAttribute("aria-expanded")).toBe("false");
  const panel = host.querySelector('[data-sidebar-pinned-circle-thread-list="Beacon"]')!;
  expect(panel.parentElement?.hasAttribute("data-sidebar-pinned-circle-row")).toBe(true);
  expect(panel.previousElementSibling?.querySelector('[data-sidebar-pinned-circle="Beacon"]')).not.toBeNull();
  toggle("Beacon");
  expect(panels()).toEqual(["Comet"]);
});

it("limits search matches to one list per row and allows switching and closing", () => {
  query = "Report";
  render();
  expect(panels()).toEqual(["Atlas", "Comet"]);
  toggle("Beacon");
  expect(panels()).toEqual(["Beacon", "Comet"]);
  toggle("Beacon");
  expect(panels()).toEqual(["Comet"]);
  query = "";
  render();
  expect(panels()).toEqual([]);
});

it("replaces the open sibling when a thread is revealed", () => {
  render();
  toggle("Atlas");
  reveal = { threadId: "Beacon-1", nonce: 1 };
  render();
  expect(panels()).toEqual(["Beacon"]);
});

it("restores the chosen list after clearing search", () => {
  render();
  toggle("Beacon");
  query = "Report";
  render();
  toggle("Atlas");
  query = "";
  render();
  expect(panels()).toEqual(["Beacon"]);
});
