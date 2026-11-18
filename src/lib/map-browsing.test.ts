import { describe, expect, it } from "vitest";
import { takeComputerPanelBrowserView } from "@/lib/computer-panel-focus";
import { readComputerPanelView } from "@/lib/computer-panel-view";
import { browsingSiteOf, keepWorking, openBotBrowser } from "./map-browsing";

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

describe("the Team map's Browsing chip", () => {
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
