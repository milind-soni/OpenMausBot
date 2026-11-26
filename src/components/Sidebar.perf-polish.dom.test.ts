// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState, StoreProvider, type Bot } from "@/state/store";

const spies = vi.hoisted(() => ({
  botListOfCalls: 0,
  attentionCalls: 0,
}));

vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("./SidebarInboxRow", () => ({ SidebarInboxRow: () => null }));
vi.mock("@/state/api", async (original) => ({ ...await original<typeof import("@/state/api")>(), api: vi.fn(async () => ({})) }));
vi.mock("@/state/inbox", async (original) => {
  const mod = await original<typeof import("@/state/inbox")>();
  return { ...mod, useInboxSupport: () => "yes" as const };
});
vi.mock("@/lib/sidebar-bot-drop", async (original) => {
  const mod = await original<typeof import("@/lib/sidebar-bot-drop")>();
  return {
    ...mod,
    botListOf: (...args: Parameters<typeof mod.botListOf>) => {
      spies.botListOfCalls += 1;
      return mod.botListOf(...args);
    },
  };
});
vi.mock("./SidebarBotActivity", async (original) => {
  const mod = await original<typeof import("./SidebarBotActivity")>();
  return {
    ...mod,
    crossBotAttentionThreads: (...args: Parameters<typeof mod.crossBotAttentionThreads>) => {
      spies.attentionCalls += 1;
      return mod.crossBotAttentionThreads(...args);
    },
  };
});

const { BotThreadList, Sidebar, botRowProps } = await import("./Sidebar");
const { useSidebarBotDrag } = await import("./SidebarBotDrag");
const { attentionHasRunningWork, crossBotAttentionThreads, hasCrossBotRunningWork } = await import("./SidebarBotActivity");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  spies.botListOfCalls = 0;
  spies.attentionCalls = 0;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const makeFleet = (count: number): Bot[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `bot-${index}`,
    threadId: `main-${index}`,
    name: `Bot ${index}`,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    section: index % 2 === 0 ? `Dept ${index % 5}` : undefined,
    messages: [],
    modelSelection: { instanceId: "fake", model: "test" },
    tasks: [
      { threadId: `main-${index}`, title: `Main ${index}`, createdAt: 10 },
      { threadId: `second-${index}`, title: `Second ${index}`, createdAt: 20 },
    ],
  }));

describe("sidebar rendering and timer polish", () => {
  it("shares a single 30s interval and visibility listener across 8 mounted BotThreadList instances", async () => {
    const intervals = new Set<number>();
    let nextId = 1;
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation(((_cb: TimerHandler, delay?: number) => {
      const id = nextId++;
      if (delay === 30_000) intervals.add(id);
      return id as unknown as ReturnType<typeof window.setInterval>;
    }) as unknown as typeof window.setInterval);
    vi.spyOn(window, "clearInterval").mockImplementation(((id?: number) => {
      if (typeof id === "number") intervals.delete(id);
    }) as unknown as typeof window.clearInterval);
    let visibilityListeners = 0;
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "visibilitychange") visibilityListeners += 1;
      origAdd(type, listener, options);
    }) as typeof document.addEventListener);
    vi.spyOn(document, "removeEventListener").mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "visibilitychange") visibilityListeners -= 1;
      origRemove(type, listener, options);
    }) as typeof document.removeEventListener);

    const fleet = makeFleet(8);
    await act(async () => {
      root.render(createElement(
        "div",
        null,
        fleet.map((bot) => createElement(BotThreadList, {
          key: bot.id,
          ...botRowProps(initialState, vi.fn(), bot, { density: "comfortable", query: "", onMenu: vi.fn() }),
          selected: false,
        })),
      ));
    });

    const thirtySecCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 30_000);
    expect(thirtySecCalls).toHaveLength(1);
    expect(intervals.size).toBe(1);
    expect(visibilityListeners).toBe(1);

    await act(async () => { root.render(null); });
    expect(intervals.size).toBe(0);
    expect(visibilityListeners).toBe(0);
  });

  it("registers zero 30s relative-clock intervals and skips crossBotAttentionThreads when Sidebar has no pinned threads and attention panel is unpinned", async () => {
    const thirtySecDelays: number[] = [];
    vi.spyOn(window, "setInterval").mockImplementation(((cb: TimerHandler, delay?: number) => {
      if (delay === 30_000) thirtySecDelays.push(delay);
      return setTimeout(cb as () => void, 1_000_000) as unknown as ReturnType<typeof window.setInterval>;
    }) as unknown as typeof window.setInterval);

    await act(async () => {
      root.render(createElement(StoreProvider, null, createElement(Sidebar, { open: true, onClose: vi.fn() })));
    });

    expect(thirtySecDelays).toHaveLength(0);
    expect(spies.attentionCalls).toBe(0);
  });

  it("indexes bot drag lists in O(1) without calling linear botListOf per row across 40 bots", async () => {
    const fleet = makeFleet(40);
    const departments = ["Dept 0", "Dept 1", "Dept 2", "Dept 3", "Dept 4"];
    const main = fleet.filter((bot) => !bot.section);
    const sectioned = fleet.filter((bot) => Boolean(bot.section));
    let rowDropCount = 0;

    function Harness() {
      const drag = useSidebarBotDrag({
        dispatch: vi.fn(),
        announce: vi.fn(),
        onNamed: vi.fn(),
        onRenamed: vi.fn(),
        onError: vi.fn(),
        onCancelled: vi.fn(),
      });
      const drops = drag.arrange({
        enabled: true,
        main,
        sectioned,
        departments,
        bots: fleet,
        taken: departments,
      });
      rowDropCount = fleet.filter((bot) => Boolean(drops.row(bot.id).botDrag)).length;
      return null;
    }

    await act(async () => { root.render(createElement(Harness)); });
    expect(rowDropCount).toBe(40);
    expect(spies.botListOfCalls).toBe(0);
  });
  it("matches attentionHasRunningWork(crossBotAttentionThreads(...)) via short-circuiting hasCrossBotRunningWork", () => {
    const idleFleet = makeFleet(10);
    expect(hasCrossBotRunningWork(idleFleet, {})).toBe(false);
    expect(hasCrossBotRunningWork(idleFleet, { "second-7": ["q"] })).toBe(
      attentionHasRunningWork(crossBotAttentionThreads(idleFleet, { "second-7": ["q"] })),
    );
    const waitingOnly = idleFleet.map((bot, i) => i === 3 ? { ...bot, tasks: [{ threadId: "main-3", title: "Ask", createdAt: 1, busy: true, activity: "waiting-on-you" as const }] } : bot);
    expect(hasCrossBotRunningWork(waitingOnly, {})).toBe(false);
    const workingFleet = idleFleet.map((bot, i) => i === 5 ? { ...bot, tasks: [{ threadId: "main-5", title: "Work", createdAt: 1, busy: true, activity: "working" as const }] } : bot);
    expect(hasCrossBotRunningWork(workingFleet, {})).toBe(true);
  });
});
