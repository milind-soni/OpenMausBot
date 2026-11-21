import { describe, expect, it, vi } from "vitest";
import { api } from "@/state/store";
import { takeComputerPanelBrowserView } from "@/lib/computer-panel-focus";
import { readComputerPanelView } from "@/lib/computer-panel-view";
import { browsingSiteOf, keepWorking, nextWorkingTurns, openBotBrowser, readMapBrowsing, type WorkingTurns } from "./map-browsing";

const reads = vi.hoisted(() => [] as Array<{ path: string; init: unknown }>);
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  api: vi.fn(async (path: string, init: unknown) => {
    reads.push({ path, init });
    return { bots: [{ botId: "ada", site: "github.com" }, { botId: "ben", site: "example.com" }] };
  }),
}));

const bot = { id: "ada", threadId: "t-main", mainThreadId: "t-main", tasks: [], busy: true };

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => { items.delete(key); },
    setItem: (key, value) => { items.set(key, value); },
  };
}

describe("the Team map's Browsing status line", () => {
  it("names the site only while the bot works", () => {
    const sites = { ada: "github.com" };
    expect(browsingSiteOf(bot, sites)).toBe("github.com");
    expect(browsingSiteOf({ ...bot, busy: false }, sites)).toBeUndefined();
    expect(browsingSiteOf({ ...bot, id: "ben" }, sites)).toBeUndefined();
  });

  it("drops the site of a bot that stopped working, so its next turn starts without one", () => {
    const sites = { ada: "github.com", ben: "example.com" };
    expect(keepWorking(sites, "ada ben")).toBe(sites);
    expect(keepWorking(sites, "ben")).toEqual({ ben: "example.com" });
    expect(keepWorking(sites, "")).toEqual({});
  });

  it("reads in the background and leaves out a bot that stopped working while the read was out", async () => {
    let working: WorkingTurns = { ada: 1, ben: 2 };
    const read = readMapBrowsing(() => working);
    working = { ben: 2 };
    expect(await read).toEqual({ ben: "example.com" });
    expect(reads).toEqual([{ path: "/api/computers/browsing", init: { background: true, timeoutMs: 10_000 } }]);
  });

  it("leaves out a bot that stopped and started again while the read was out, since the answer is from its last turn", async () => {
    let working: WorkingTurns = { ada: 1, ben: 2 };
    const read = readMapBrowsing(() => working);
    working = { ada: 3, ben: 2 };
    expect(await read).toEqual({ ben: "example.com" });
  });

  it("numbers a bot's turn when it starts working and keeps the number while it works", () => {
    let turn = 0;
    const next = () => ++turn;
    const first = nextWorkingTurns({}, "ada ben", next);
    expect(first).toEqual({ ada: 1, ben: 2 });
    expect(nextWorkingTurns(first, "ben", next)).toEqual({ ben: 2 });
    expect(nextWorkingTurns(nextWorkingTurns(first, "ben", next), "ada ben", next)).toEqual({ ada: 3, ben: 2 });
    expect(nextWorkingTurns(first, "", next)).toEqual({});
  });

  it("reads only a bot's own entries, so an id such as constructor gets a new turn and no inherited site", () => {
    let turn = 0;
    const next = () => ++turn;
    const first = nextWorkingTurns({}, "constructor", next);
    expect(first).toEqual({ constructor: 1 });
    expect(nextWorkingTurns(nextWorkingTurns(first, "", next), "constructor", next)).toEqual({ constructor: 2 });
    expect(browsingSiteOf({ ...bot, id: "constructor" }, {})).toBeUndefined();
  });

  it("leaves out a read entry for an id such as constructor when no bot by that id is working", async () => {
    vi.mocked(api).mockResolvedValueOnce({ bots: [{ botId: "constructor", site: "github.com" }] });
    expect(await readMapBrowsing(() => ({}))).toEqual({});
  });

  it("opens the bot's chat with its Browser panel open", () => {
    const storage = memoryStorage();
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      const actions: unknown[] = [];
      openBotBrowser((action) => actions.push(action), bot, false, {} as HTMLElement, false);
      expect(actions).toEqual([{ type: "select", id: "ada" }, { type: "toggleComputer", open: true, botId: "ada" }]);
      expect(readComputerPanelView("ada", storage)).toBe("browser");
      expect(takeComputerPanelBrowserView("ada")).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  });
});
