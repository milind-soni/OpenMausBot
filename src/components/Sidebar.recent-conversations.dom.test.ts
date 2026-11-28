// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PHONE_LAYOUT } from "@/lib/use-media-query";
import { setLocale } from "@/lib/i18n";
import { BotEditorStore, initialState, type Bot, type Group } from "@/state/store";
import { Sidebar } from "./Sidebar";

vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: false, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));

const bot = (id: string, section: string, activityAt: number): Bot => ({
  id, name: id, section, threadId: `${id}-main`, title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: `${id}-main`, title: `${id} main`, createdAt: 1, lastThreadOrderAt: activityAt }],
});
const room: Group = {
  id: "room", name: "Launch room", memberIds: [], defaultResponder: { kind: "auto" }, bulletin: "", unread: false,
  threadId: "room-main", section: "Launch", createdAt: 1, messages: [],
  tasks: [{ threadId: "launch-plan", title: "Launch plan", createdAt: 2, updatedAt: 20 }],
};
const dispatch = vi.fn();
const onClose = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  localStorage.clear();
  setLocale("en");
  dispatch.mockClear();
  onClose.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(bots: Bot[]) {
  await act(async () => root.render(createElement(BotEditorStore, {
    value: {
      state: { ...initialState, connected: true, bots, groups: [room], selectedId: "Scout", activeView: "chat" },
      dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
    },
    children: createElement(Sidebar, { open: true, onClose }),
  })));
}
const rows = () => [...host.querySelectorAll<HTMLButtonElement>("button[data-sidebar-recent-thread]")];
const order = () => rows().map((row) => row.dataset.sidebarRecentThread);
const departmentOrder = () => [...host.querySelectorAll<HTMLElement>("[data-sidebar-section-id]")].map((section) => section.dataset.sidebarSectionId);

it.each([false, true])("shows cross-department activity and opens the exact conversation (phone=%s)", async (phone) => {
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation((query) => {
    const match = matchMedia(query);
    Object.defineProperty(match, "matches", { value: phone && query === PHONE_LAYOUT });
    return match;
  });
  const scout = bot("Scout", "Research", 10);
  const builder = bot("Builder", "Engineering", 30);
  builder.tasks!.push(
    { threadId: "archived", title: "Archived", createdAt: 100, archivedAt: 0 },
    { threadId: "routine", title: "Routine", createdAt: 100, routineRunId: "run" },
  );
  const hidden = { ...bot("Hidden", "Operations", 100), hidden: true };
  await render([scout, builder, hidden]);

  expect(order()).toEqual(["Builder-main", "launch-plan", "Scout-main"]);
  expect(rows()[2]?.getAttribute("aria-current")).toBe("page");
  const firstDepartment = host.querySelector("[data-sidebar-section-id]")!;
  expect(rows()[0]!.compareDocumentPosition(firstDepartment) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const sections = departmentOrder();
  expect(sections).toContain("section:Research");
  expect(sections).toContain("section:Engineering");

  const activeScout = { ...scout, tasks: [{ ...scout.tasks![0]!, lastThreadOrderAt: 40 }] };
  await render([activeScout, builder, hidden]);
  expect(order()).toEqual(["Scout-main", "Builder-main", "launch-plan"]);
  expect(departmentOrder()).toEqual(sections);

  await act(async () => rows()[1]!.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "Builder", threadId: "Builder-main" });
  await act(async () => rows()[2]!.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "switchGroupTask", groupId: "room", threadId: "launch-plan" });
  expect(onClose).toHaveBeenCalledTimes(phone ? 2 : 0);

  const toggle = host.querySelector<HTMLButtonElement>("[data-sidebar-recent] button[aria-expanded]")!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(order()).toEqual([]);
  await act(async () => toggle.click());
  expect(order()).toEqual(["Scout-main", "Builder-main", "launch-plan"]);
});
