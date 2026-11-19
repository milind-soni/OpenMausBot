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
const catalog = (count: number, edition = 0) => Array.from({ length: count }, (_, index) => ({
  slug: `app${index}`, label: `App ${index}${edition ? ` v${edition}` : ""}`, blurb: `does thing ${index}`, logo: null, domain: null, categories: [`Kind ${index % 9}`],
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
const loadingShown = () => host.textContent!.includes(t("connectors.loadingCatalog"));

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  Object.assign(fixture, { cards: catalog(40), catalogRequests: 0, held: [], hold: false, tileRenders: 0 });
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
    expect(refreshed).toContain("App 0 v2");
  });
});
