// @vitest-environment happy-dom
// A long app list mounts only the grid rows near the view, and still finds, scrolls to and focuses every app.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  cards: [] as Array<{ slug: string; label: string; blurb: string; logo: null; domain: null; categories: string[] }>,
  tileRenders: 0,
  xTile: false,
  state: { pluginsSurface: "apps", bots: [], instances: [], config: null } as Record<string, unknown>,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/api/connectors/catalog") return { cards: fixture.cards, source: "api", configured: true, mode: "managed", setup: "ready" };
    if (path.startsWith("/api/connectors/suggestions")) return { cards: [], pick: "available" };
    throw new Error(`unexpected ${path}`);
  }),
  useStore: () => ({ state: fixture.state, dispatch: () => {} }),
}));
vi.mock("./ServiceIcon", () => ({
  ServiceIcon: ({ className }: { className?: string }) => {
    if (className?.includes("size-10")) fixture.tileRenders += 1;
    return null;
  },
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/connected-apps", () => ({
  preloadConnectedApps: vi.fn(async () => ({ services: {}, authoritative: true })),
  connectorStatusMemory: () => null,
  rememberConnectorStatus: () => {},
}));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: () => null, writeCachedInventory: () => {} }));
vi.mock("@/lib/product-events", () => ({ connectorConnect: vi.fn() }));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => null }));
vi.mock("./github/GithubAppCard", () => ({ GITHUB_CARD_SEARCH: "github git", GITHUB_CARD_CATEGORIES: ["Developer tools"], GithubAppCard: () => null }));
vi.mock("@/lib/github-sign-in", () => ({ useGithubConnected: () => null, useGithubShown: () => true }));
vi.mock("./XCard", async () => {
  const { createElement: element } = await import("react");
  return { X_CARD_SEARCH: "x", XCard: () => fixture.xTile ? element("div", { "data-app-tile": "x" }, "X") : null };
});
vi.mock("./PostizCard", () => ({ PostizCard: () => null }));
vi.mock("./EmailCard", () => ({ EmailCard: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const { PluginsPanel } = await import("./PluginsPanel");
const { StoreSourceContext } = await import("@/state/store-context");
const { t } = await import("@/lib/i18n");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS = 1000;
const VIEW = 640;
const TILE = 56;
const KINDS = ["Mail", "Sheet", "Chat", "Code", "Pay", "Docs", "Cal", "Crm", "Ads", "Map"];
const catalog = (count: number) => Array.from({ length: count }, (_, index) => ({
  slug: `app${index}`, label: `${KINDS[index % KINDS.length]} ${index}`, blurb: `does thing ${index}`, logo: null, domain: null, categories: [`Kind ${index % 9}`],
}));

// happy-dom lays nothing out: the pop-up's scroller gets a fixed view, each tile a fixed height, the list starts at the
// top of the scrolled content, and in two-column mode the grid resolves its columns and row gap as the browser would.
const layout = vi.hoisted(() => ({ columns: 1 }));
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("overflow-y-auto")) return VIEW;
    return this.hasAttribute("data-app-tile") ? TILE : 0;
  },
});
const realRect = Element.prototype.getBoundingClientRect;
Element.prototype.getBoundingClientRect = function (this: Element) {
  const view = this.closest<HTMLElement>(".overflow-y-auto");
  return view && view !== this ? DOMRect.fromRect({ x: 0, y: -view.scrollTop, width: 0, height: 0 }) : realRect.call(this);
};
const realStyle = window.getComputedStyle.bind(window);
vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
  const style = realStyle(element);
  const classes = element.classList;
  const resolved: Record<string, string> = {
    display: classes.contains("contents") ? "contents" : classes.contains("hidden") ? "none" : style.display,
    gridColumnEnd: classes.contains("col-span-full") ? "-1" : "auto",
    gridTemplateColumns: classes.contains("grid") ? Array.from({ length: layout.columns }, () => "300px").join(" ") : "none",
    rowGap: classes.contains("grid") && layout.columns > 1 ? "4px" : "normal",
  };
  return new Proxy(style, { get: (target, key) => typeof key === "string" && key in resolved ? resolved[key] : target[key as keyof CSSStyleDeclaration] });
});

const source = { getState: () => fixture.state, subscribe: () => () => {}, dispatch: () => {} } as never;
let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const draw = async () => {
  await act(async () => root.render(createElement(StoreSourceContext, { value: source }, createElement(PluginsPanel))));
  await flush();
};
const open = async () => {
  root = createRoot(host);
  await draw();
};
const scroller = () => host.querySelector<HTMLElement>(".overflow-y-auto")!;
const list = () => host.querySelector<HTMLElement>('[data-apps-section="apps-grid-title"] .grid')!;
const listed = () => Array.from(list().querySelectorAll<HTMLElement>("[data-app-tile]")).map((tile) => tile.dataset.appTile!).filter((slug) => slug !== "x");
const mounted = () => host.querySelectorAll("[data-app-tile]").length;
const scrollTo = async (top: number) => {
  Object.defineProperty(scroller(), "scrollTop", { configurable: true, value: top });
  await act(async () => { scroller().dispatchEvent(new Event("scroll")); });
  await flush();
};
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent === text)!;
const showAll = async () => {
  await act(async () => button(t("apps.showAll", { count: APPS.toLocaleString("en-US") })).click());
  await flush();
};
const type = async (text: string) => {
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await flush();
};
/** The list's rows below the first `skip` grid items, as the browser stacks them: each spacer and each row of tiles is
 * one grid row. */
const listHeight = (skip = 0) => {
  let height = 0;
  let rows = 0;
  let inRow = 0;
  const items = Array.from(list().querySelectorAll("[data-tile-gap], [data-app-tile]")).slice(skip);
  for (const item of items) {
    if (item.hasAttribute("data-tile-gap")) {
      height += parseFloat((item as HTMLElement).style.height);
      rows += 1;
      inRow = 0;
    } else if (inRow++ % layout.columns === 0) {
      height += TILE;
      rows += 1;
    }
  }
  const gap = layout.columns > 1 ? 4 : 0;
  return height + Math.max(0, rows - 1) * gap;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  fixture.cards = catalog(APPS);
  fixture.tileRenders = 0;
  fixture.xTile = false;
  layout.columns = 1;
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("a long app list", () => {
  it("mounts a bounded number of tiles for a 1,000-app catalog, and keeps the grid its full height", async () => {
    await open();
    await showAll();
    const rows = Math.ceil(VIEW / TILE) + 6;
    expect(listed().length).toBeGreaterThan(0);
    expect(listed().length).toBeLessThanOrEqual(rows + 1);
    expect(listed()[0]).toBe("app0");
    expect(mounted()).toBeLessThan(60);
    expect(listHeight()).toBe(APPS * TILE);
  });

  it("mounts the rows scrolled to and lets go of those scrolled past", async () => {
    await open();
    await showAll();
    await scrollTo(500 * TILE);
    const shown = listed();
    expect(shown).toContain("app500");
    expect(shown).toContain("app505");
    expect(shown).not.toContain("app0");
    expect(shown).not.toContain("app999");
    const indexes = shown.map((slug) => Number(slug.slice(3)));
    expect(indexes).toEqual(indexes.map((_, offset) => indexes[0]! + offset));
    expect(listHeight()).toBe(APPS * TILE);

    await scrollTo(APPS * TILE);
    expect(listed().at(-1)).toBe("app999");
    expect(listHeight()).toBe(APPS * TILE);
  });

  it("keeps the scroll where it is and mounts the rows in view when Show all opens the list part way down", async () => {
    await open();
    const writes: number[] = [];
    let top = 30 * TILE;
    Object.defineProperty(scroller(), "scrollTop", { configurable: true, get: () => top, set: (value: number) => { writes.push(value); top = value; } });
    scroller().scrollTo = ((options: ScrollToOptions) => { writes.push(options.top ?? top); top = options.top ?? top; }) as HTMLElement["scrollTo"];
    await showAll();
    expect(writes.filter((value) => value !== 30 * TILE)).toEqual([]);
    expect(listed()).toContain("app30");
    expect(listed()).toContain("app40");
    expect(listed()).not.toContain("app0");
    expect(listHeight()).toBe(APPS * TILE);
  });

  it("finds an app far down the list by search", async () => {
    await open();
    await type("Map 999");
    expect(listed()).toEqual(["app999"]);
    await type("does thing");
    expect(listed().length).toBeLessThan(30);
    await type("does thing 99");
    expect(listed()).toHaveLength(19);
    expect(listed().at(-1)).toBe("app999");
  });

  it("lays two columns out in rows of two after a native card, as the grid places them", async () => {
    layout.columns = 2;
    fixture.xTile = true;
    await open();
    await showAll();
    const before = Array.from(list().querySelectorAll("[data-tile-gap], [data-app-tile]"));
    expect(before.slice(0, 3).map((child) => child.getAttribute("data-app-tile"))).toEqual(["x", "app0", "app1"]);
    expect(listHeight(2)).toBe(Math.ceil((APPS - 1) / 2) * TILE + (Math.ceil((APPS - 1) / 2) - 1) * 4);

    await scrollTo(200 * (TILE + 4));
    const items = Array.from(list().querySelectorAll("[data-tile-gap], [data-app-tile]"));
    expect(items.slice(0, 3).map((child) => child.getAttribute("data-app-tile") ?? "gap")).toEqual(["x", "app0", "gap"]);
    const after = listed().slice(1).map((slug) => Number(slug.slice(3)));
    expect(after[0]! % 2).toBe(1);
    expect(after.length % 2).toBe(0);
    expect(after).toContain(1 + 200 * 2);
    expect(listHeight(2)).toBe(Math.ceil((APPS - 1) / 2) * TILE + (Math.ceil((APPS - 1) / 2) - 1) * 4);
  });
});

describe("keyboard focus in a long app list", () => {
  it("reaches the next tile by Tab once the browser scrolls the focused one into view", async () => {
    await open();
    await showAll();
    const last = listed().at(-1)!;
    const index = Number(last.slice(3));
    const control = list().querySelector<HTMLButtonElement>(`[data-app-tile="${last}"] button`)!;
    act(() => control.focus());
    // The browser scrolls a focused control into view: here, the bottom of its row to the bottom of the view.
    await scrollTo((index + 1) * TILE - VIEW);
    expect(document.activeElement).toBe(control);
    const tiles = Array.from(list().querySelectorAll("[data-app-tile]"));
    const position = tiles.findIndex((tile) => tile.contains(control));
    expect(tiles[position + 1]?.getAttribute("data-app-tile")).toBe(`app${index + 1}`);
  });

  it("keeps the focused tile mounted while the list scrolls far away, after the list was taken off the page and back", async () => {
    await open();
    await showAll();
    fixture.state = { ...fixture.state, pluginsSurface: "mcp" };
    await draw();
    expect(host.querySelector('[data-apps-section="apps-grid-title"]')).toBeNull();
    fixture.state = { ...fixture.state, pluginsSurface: "apps" };
    await draw();
    const control = list().querySelector<HTMLButtonElement>('[data-app-tile="app2"] button')!;
    act(() => control.focus());
    await scrollTo(700 * TILE);
    expect(listed()).toContain("app700");
    expect(listed()).toContain("app2");
    expect(document.activeElement).toBe(control);
    expect(listHeight()).toBe(APPS * TILE);
  });
});
