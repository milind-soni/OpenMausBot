// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { initialState, type Bot } from "@/state/store";
import { PinnedBotRoster } from "./PinnedCircleThreads";
import type { BotRowProps } from "./Sidebar";

vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => true }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./Sidebar", () => ({ BotListItem: () => null, BotThreadList: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const bots = ["Atlas", "Beacon", "Comet"].map((name): Bot => ({
  id: name, threadId: name, name, title: "", description: "", notifications: true,
  color: "green", unread: false, pinned: true, messages: [],
  modelSelection: { instanceId: "fake", model: "test" },
  tasks: [1, 2].map((n) => ({ threadId: `${name}-${n}`, title: `Report ${n}`, createdAt: n })),
}));
let host: HTMLDivElement;
let root: Root;
function render(query = "", reveal: BotRowProps["reveal"] = null) {
  act(() => root.render(createElement(PinnedBotRoster, {
    bots, density: "comfortable", circles: true, listItem: () => null,
    row: (bot): BotRowProps => ({ bot, selected: false, deleting: false, mascotMotion: null,
      reveal: bot.tasks?.some(task => task.threadId === reveal?.threadId) ? reveal : null,
      pendingQueued: initialState.pendingQueued, instances: [], liveCall: null,
      locale: "en", density: "comfortable", query, dispatch: vi.fn(), onMenu: vi.fn() }),
  })));
}
const arrow = (id: string) => host.querySelector<HTMLButtonElement>(`button[aria-controls="pinned-circle-threads-${id}"]`)!;
const toggle = (id: string) => act(() => arrow(id).click());
function expectOpen(id: string | null) {
  expect(bots.filter(bot => arrow(bot.id).getAttribute("aria-expanded") === "true").map(bot => bot.id)).toEqual(id ? [id] : []);
  const panels = [...host.querySelectorAll<HTMLElement>("[data-sidebar-pinned-circle-thread-list]")];
  expect(panels.map(el => el.dataset.sidebarPinnedCircleThreadList)).toEqual(id ? [id] : []);
  if (id) expect(panels[0]?.previousElementSibling?.contains(arrow(id))).toBe(true);
}
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(180);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.restoreAllMocks(); });

it("switches within a row and across rows, then closes the last panel", () => {
  render();
  expect(arrow("Atlas").closest(".grid")).not.toBe(arrow("Comet").closest(".grid"));
  for (const id of ["Atlas", "Beacon", "Comet"]) {
    toggle(id);
    expectOpen(id);
  }
  toggle("Comet");
  expectOpen(null);
});

it("shows one search match, restores the manual choice, and switches rows on reveal", () => {
  render();
  toggle("Beacon");
  render("Report");
  expectOpen("Atlas");
  toggle("Comet");
  expectOpen("Comet");
  render();
  expectOpen("Beacon");
  render("", { threadId: "Comet-1", nonce: 1 });
  expectOpen("Comet");
});
