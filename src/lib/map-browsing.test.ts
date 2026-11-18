import { describe, expect, it } from "vitest";
import { takeComputerPanelBrowserView } from "@/lib/computer-panel-focus";
import { readComputerPanelView } from "@/lib/computer-panel-view";
import { browsingSiteOf, openBotBrowser } from "./map-browsing";

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

  it("opens the bot's chat with its Browser panel open", () => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    const actions: unknown[] = [];
    openBotBrowser((action) => actions.push(action), bot, false, {} as HTMLElement, false);
    expect(actions).toEqual([{ type: "select", id: "ada" }, { type: "toggleComputer", open: true, botId: "ada" }]);
    expect(readComputerPanelView("ada", storage)).toBe("browser");
    expect(takeComputerPanelBrowserView("ada")).toBe(true);
  });
});
