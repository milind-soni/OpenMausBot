// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type Bot, type Task, type useStore } from "@/state/store";
import { setAdvancedMode } from "@/lib/interface-mode";
import { setShowThreads } from "@/lib/thread-preferences";
import { BotListItem, botRowProps } from "./Sidebar";
import { SidebarBotTile } from "./SidebarTiles";

vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const task = (threadId: string, extra: Partial<Task> = {}): Task => ({ threadId, title: threadId, createdAt: 1, ...extra });
const teammate: Bot = {
  id: "ledger", name: "Ledger", threadId: "main", mainThreadId: "main", title: "", description: "",
  color: "green", notifications: true, unread: false, messages: [], modelSelection: { instanceId: "fake", model: "m" },
  tasks: [task("main"), task("work", { activity: "waiting-on-you", busy: true, openedBy: { botId: "scout", name: "Scout", at: 1 } })],
};
let root: Root | undefined;
let host: HTMLDivElement | undefined;
const dispatch = vi.fn();
function mount(bot = teammate, tile = false, density: "comfortable" | "compact" | "icons" = "comfortable") {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const state = { ...initialState, bots: [bot], selectedId: "scout", activeView: "chat" as const };
  const row = botRowProps(state, dispatch, bot, { density, quiet: false, query: "", onMenu: vi.fn() });
  act(() => root!.render(createElement(BotEditorStore, { value: { state, dispatch } as unknown as ReturnType<typeof useStore>, children: createElement(tile ? SidebarBotTile : BotListItem, row) })));
  return host.querySelector<HTMLElement>('[data-sidebar-bot-row="ledger"]')!;
}
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = undefined; dispatch.mockReset(); setAdvancedMode(false); setShowThreads(true); });

describe("a teammate waiting in another conversation", () => {
  it.each(["comfortable", "compact", "icons", "tile"] as const)("opens the waiting card from Simple's existing waiting marker (%s)", (surface) => {
    setAdvancedMode(false);
    const row = mount(teammate, surface === "tile", surface === "tile" ? "comfortable" : surface);
    expect(host!.textContent + row.getAttribute("aria-label")).toContain("Waiting for you");
    act(() => row.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "switchTask", botId: "ledger", threadId: "work" }]);
  });

  it("opens the same waiting conversation with the keyboard", () => {
    setAdvancedMode(false);
    const row = mount();
    act(() => row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "ledger", threadId: "work" });
  });

  it("keeps the question already on screen when several conversations wait", () => {
    setAdvancedMode(false);
    const row = mount({ ...teammate, threadId: "work", tasks: [task("other", { activity: "waiting-on-you" }), ...teammate.tasks!] });
    act(() => row.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "ledger", threadId: "work" });
  });

  it("opens the next waiting conversation after the first answer", () => {
    setAdvancedMode(false);
    const row = mount({ ...teammate, threadId: "work", tasks: [task("main"), task("work", { activity: "idle" }), task("next", { activity: "waiting-on-you" })] });
    act(() => row.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "ledger", threadId: "next" });
  });

  it("keeps Advanced's thread links and ordinary bot selection", () => {
    setAdvancedMode(true); setShowThreads(true);
    const row = mount();
    expect(host!.querySelector('[data-sidebar-activity-row="work"]')).not.toBeNull();
    act(() => row.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "ledger" }]);
  });

  it("keeps the main chat for idle and archived conversations", () => {
    setAdvancedMode(false);
    const row = mount({ ...teammate, tasks: [task("main"), task("idle"), task("archived", { activity: "waiting-on-you", archivedAt: 2 })] });
    act(() => row.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "ledger" }]);
  });

  it("opens a routine run that waits, since the waiting marker counts it", () => {
    setAdvancedMode(false);
    const row = mount({ ...teammate, activity: "waiting-on-you", tasks: [task("main"), task("routine", { activity: "waiting-on-you", routineRunId: "run" })] });
    act(() => row.click());
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: "ledger", threadId: "routine" });
  });
});
