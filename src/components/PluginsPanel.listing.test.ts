// @vitest-environment happy-dom
// What the Apps panel paints and how often, counted: catalog requests, whether the loading line shows, tile renders.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  cards: [] as Array<{ slug: string; label: string; blurb: string; logo: null; domain: null; categories: string[] }>,
  catalogRequests: 0,
  held: [] as Array<() => void>,
  hold: false,
  tileRenders: 0,
  state: { pluginsSurface: "apps", bots: [], instances: [], config: null, tick: 0 } as Record<string, unknown>,
  watchers: new Set<() => void>(),
}));

vi.mock("@/state/store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (watch: () => void) => {
    fixture.watchers.add(watch);
    return () => fixture.watchers.delete(watch);
  };
  return {
    api: vi.fn(async (path: string) => {
      if (path === "/api/connectors/catalog") {
        fixture.catalogRequests += 1;
        const cards = fixture.cards;
        if (fixture.hold) await new Promise<void>((resolve) => fixture.held.push(resolve));
        return { cards, source: "api", configured: true, mode: "managed", setup: "ready" };
      }
      if (path.startsWith("/api/connectors/suggestions")) return { cards: [], pick: "available" };
      throw new Error(`unexpected ${path}`);
    }),
    // As the real one: a reader of the whole store, rendered again by every change to it.
    useStore: () => ({ state: useSyncExternalStore(subscribe, () => fixture.state), dispatch: () => {} }),
  };
});
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
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: () => null }));
vi.mock("./PostizCard", () => ({ PostizCard: () => null }));
vi.mock("./EmailCard", () => ({ EmailCard: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

const { PluginsPanel } = await import("./PluginsPanel");
const { StoreSourceContext } = await import("@/state/store-context");
const { t } = await import("@/lib/i18n");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = {
  getState: () => fixture.state,
  subscribe: (watch: () => void) => {
    fixture.watchers.add(watch);
    return () => fixture.watchers.delete(watch);
  },
  dispatch: () => {},
} as never;
const KINDS = ["Mail", "Sheet", "Chat", "Code", "Pay", "Docs", "Cal", "Crm", "Ads", "Map"];
const catalog = (count: number, edition = 0) => Array.from({ length: count }, (_, index) => ({
  slug: `app${index}`, label: `${KINDS[index % KINDS.length]} ${index}${edition ? ` v${edition}` : ""}`, blurb: `does thing ${index}`, logo: null, domain: null, categories: [`Kind ${index % 9}`],
}));

let host: HTMLDivElement;
let root: Root | null = null;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async () => {
  root = createRoot(host);
  await act(async () => root!.render(createElement(StoreSourceContext, { value: source }, createElement(PluginsPanel))));
  await flush();
};
const close = async () => {
  await act(async () => root?.unmount());
  root = null;
};
const answerCatalog = async () => {
  for (const answer of fixture.held.splice(0)) answer();
  await flush();
};
const tiles = () => host.querySelectorAll("[data-app-tile]").length;
/** The tiles rendered, first time or again, while `step` ran. */
const tileRenders = async (step: () => void) => {
  const before = fixture.tileRenders;
  await act(async () => step());
  await flush();
  return fixture.tileRenders - before;
};
/** The tiles rendered while `step` ran, and the tiles it put on the page that were not on it before. */
const rendersAndAdded = async (step: () => void) => {
  const before = new Set(host.querySelectorAll("[data-app-tile]"));
  const renders = await tileRenders(step);
  return { renders, added: Array.from(host.querySelectorAll("[data-app-tile]")).filter((tile) => !before.has(tile)).length };
};
const storeChange = () => {
  fixture.state = { ...fixture.state, tick: Number(fixture.state.tick) + 1 };
  for (const watch of Array.from(fixture.watchers)) watch();
};
const type = (text: string) => {
  const input = host.querySelector("input")!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const loadingShown = () => host.textContent!.includes(t("connectors.loadingCatalog"));

// happy-dom lays nothing out: a long list needs a view to mount the rows in it.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    if (this.classList.contains("overflow-y-auto")) return 640;
    return this.hasAttribute("data-app-tile") ? 56 : 0;
  },
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  Object.assign(fixture, { cards: catalog(40), catalogRequests: 0, held: [], hold: false, tileRenders: 0 });
  fixture.state = { pluginsSurface: "apps", bots: [], instances: [], config: null, tick: 0 };
});
afterEach(async () => {
  await close();
  host.remove();
});

describe("opening the Apps panel again", () => {
  it("paints the apps it already has at once, reads the catalog again behind them, and shows what changed", async () => {
    fixture.hold = true;
    await open();
    const firstOpen = { tiles: tiles(), loadingShown: loadingShown() };
    await answerCatalog();
    const loaded = tiles();
    await close();

    fixture.cards = catalog(40, 2);
    fixture.catalogRequests = 0;
    await open();
    const reopened = { tiles: tiles(), loadingShown: loadingShown(), catalogRequests: fixture.catalogRequests };
    await answerCatalog();
    const refreshed = host.querySelector('[data-app-tile="app0"]')!.textContent;

    expect(firstOpen).toEqual({ tiles: 0, loadingShown: true });
    expect(loaded).toBeGreaterThan(0);
    expect(reopened).toEqual({ tiles: loaded, loadingShown: false, catalogRequests: 1 });
    expect(refreshed).toContain("Mail 0 v2");
  });
});

describe("how often the Apps panel renders its tiles", () => {
  const APPS = 300;
  beforeEach(async () => {
    fixture.cards = catalog(APPS);
    await open();
  });

  it("renders no tile again for a store change that is not about apps, however many show", async () => {
    expect(tiles()).toBeGreaterThan(0);
    expect(await tileRenders(storeChange)).toBe(0);

    const showAll = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === t("apps.showAll", { count: String(APPS) }))!;
    const shown = await rendersAndAdded(() => showAll.click());
    expect(shown.renders).toBe(shown.added);
    expect(tiles()).toBeGreaterThan(0);
    expect(tiles()).toBeLessThan(APPS);
    expect(await tileRenders(storeChange)).toBe(0);
  });

  it("renders no tile again for a config frame that brings the same policy, and every tile for one that changes it", async () => {
    const policy = () => ({ organizationName: "Acme", apps: { allowAll: false, allowlist: ["app0"] } });
    const withConfig = (managedPolicy: unknown) => () => {
      fixture.state = { ...fixture.state, config: { managedPolicy } };
      for (const watch of Array.from(fixture.watchers)) watch();
    };
    await tileRenders(withConfig(policy()));
    expect(await tileRenders(withConfig(policy()))).toBe(0);
    expect(await tileRenders(withConfig({ ...policy(), organizationName: "Other" }))).toBe(tiles());
  });

  it("renders only the tiles a search brings in, and none of those it keeps as the search narrows", async () => {
    const all = APPS / KINDS.length;
    const m = await rendersAndAdded(() => type("m"));
    expect(m.renders).toBeGreaterThan(0);
    expect(m.renders).toBe(m.added);
    expect(tiles()).toBeLessThan(3 * all);
    const ma = await rendersAndAdded(() => type("ma"));
    expect(ma.renders).toBe(ma.added);
    expect(tiles()).toBeLessThan(2 * all);
    const mai = await rendersAndAdded(() => type("mai"));
    expect(mai.renders).toBe(mai.added);
    expect(tiles()).toBe(all);
    expect(host.querySelector("input")!.value).toBe("mai");
    expect(await tileRenders(storeChange)).toBe(0);
  });

  it("renders a tile again when its own app changes", async () => {
    fixture.cards = catalog(APPS).map((card) => card.slug === "app0" ? { ...card, blurb: "now does more" } : card);
    const { appCatalogAnnounced } = await import("@/lib/app-catalog-signal");
    const shownIn = host.querySelectorAll('[data-app-tile="app0"]').length;
    expect(shownIn).toBeGreaterThan(0);
    expect(await tileRenders(appCatalogAnnounced)).toBe(shownIn);
    expect(host.querySelector('[data-app-tile="app0"]')!.textContent).toContain("now does more");
  });
});
