// @vitest-environment happy-dom
// The Apps panel with no Composio key, with the person's own key, and with a connection service that is down.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Catalog = { configured: boolean; mode: "managed" | "self-hosted" | "unavailable"; setup: "ready" | "needs-setup" | "service-unavailable" };

const fixture = vi.hoisted(() => ({
  catalog: { configured: false, mode: "unavailable", setup: "needs-setup" } as Catalog,
  state: { pluginsSurface: "apps", bots: [], instances: [], config: null } as Record<string, unknown>,
  dispatched: [] as unknown[],
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string) => {
    if (path === "/api/connectors/catalog") {
      return {
        cards: [
          { slug: "gmail", label: "Gmail", blurb: "Read and send mail", logo: null, domain: null, categories: ["Communication"] },
          { slug: "notion", label: "Notion", blurb: "Pages and databases", logo: null, domain: null, categories: ["Productivity"] },
        ],
        source: "curated",
        ...fixture.catalog,
      };
    }
    if (path.startsWith("/api/connectors/suggestions")) return { cards: [], pick: "available" };
    throw new Error(`unexpected ${path}`);
  }),
  useStore: () => ({ state: fixture.state, dispatch: () => {} }),
}));
vi.mock("./ServiceIcon", () => ({ ServiceIcon: () => null }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/connected-apps", () => ({
  preloadConnectedApps: vi.fn(async () => ({ services: {}, authoritative: true })),
  connectorStatusMemory: () => null,
  rememberConnectorStatus: () => {},
}));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: () => null, writeCachedInventory: () => {} }));
vi.mock("@/lib/app-catalog-cache", async (load) => {
  const actual = await load<typeof import("@/lib/app-catalog-cache")>();
  return { ...actual, appCatalogMemory: () => null };
});
vi.mock("./McpServersPanel", async () => {
  const { HOSTED_MCP_APPS } = await import("@/lib/hosted-mcp-apps");
  const none = Object.fromEntries(HOSTED_MCP_APPS.map((app) => [app.id, false]));
  return {
    McpServersPanel: ({ embedded, hostedCards }: { embedded?: boolean; hostedCards?: { onConnections?: (value: Record<string, boolean>) => void } }) => {
      if (hostedCards?.onConnections) queueMicrotask(() => hostedCards.onConnections!(none));
      return embedded ? createElement("div", { "data-mcp-list": "" }) : null;
    },
  };
});
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: ({ onConnection }: { onConnection: (value: boolean) => void }) => { queueMicrotask(() => onConnection(false)); return null; } }));
vi.mock("./PostizCard", () => ({ PostizCard: ({ onConnection }: { onConnection: (value: boolean) => void }) => { queueMicrotask(() => onConnection(false)); return null; } }));
vi.mock("./EmailCard", () => ({ EmailCard: ({ onConnection }: { onConnection: (value: boolean) => void }) => { queueMicrotask(() => onConnection(false)); return null; } }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));
vi.mock("./keys/key-focus", async (load) => {
  const actual = await load<typeof import("./keys/key-focus")>();
  return { ...actual, openKeySettings: vi.fn(actual.openKeySettings) };
});

const { PluginsPanel } = await import("./PluginsPanel");
const { StoreSourceContext } = await import("@/state/store-context");
const { t } = await import("@/lib/i18n");
const { openKeySettings } = await import("./keys/key-focus");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = {
  getState: () => fixture.state,
  subscribe: () => () => {},
  dispatch: (action: unknown) => { fixture.dispatched.push(action); },
} as never;

let host: HTMLDivElement;
let root: Root | null = null;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async (catalog: Catalog) => {
  fixture.catalog = catalog;
  root = createRoot(host);
  await act(async () => root!.render(createElement(StoreSourceContext, { value: source }, createElement(PluginsPanel))));
  await flush();
  await flush();
};
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === name);
const tileAction = (slug: string) => host.querySelector(`[data-app-tile="${slug}"]`)!;
const click = async (element: Element | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await flush();
};
const type = async (text: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${t("connectors.searchPlaceholder")}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const before = (first: Element, second: Element) => Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

const NO_KEY: Catalog = { configured: false, mode: "unavailable", setup: "needs-setup" };
const OWN_KEY: Catalog = { configured: true, mode: "self-hosted", setup: "ready" };
const SERVICE_DOWN: Catalog = { configured: false, mode: "unavailable", setup: "service-unavailable" };

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  fixture.dispatched = [];
  vi.mocked(openKeySettings).mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
});

describe("Apps with no Composio key", () => {
  it("shows three plain steps with one Paste key action that opens the key's field", async () => {
    await open(NO_KEY);
    const steps = host.querySelector("[data-apps-key-steps]")!;
    expect(steps.querySelectorAll("li")).toHaveLength(3);
    expect(steps.textContent).toContain(t("connectors.setup.step1"));
    expect(steps.textContent).toContain(t("connectors.setup.step2"));
    expect(steps.textContent).toContain(t("connectors.setup.step3"));
    expect(steps.querySelector("a")?.getAttribute("href")).toBe("https://dashboard.composio.dev");

    await click(steps.querySelector("[data-apps-paste-key]")!);
    expect(fixture.dispatched).toContainEqual({ type: "togglePlugins", open: false });
    expect(fixture.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "connections" });
    expect(openKeySettings).toHaveBeenCalledWith("composio");
  });

  it("says on each app why it can't connect yet, instead of a greyed-out button", async () => {
    await open(NO_KEY);
    for (const slug of ["gmail", "notion"]) {
      expect(tileAction(slug).querySelector("[data-app-needs-key]")?.textContent).toBe(t("connectors.tile.needsKey"));
      expect(tileAction(slug).querySelector("button")).toBeNull();
    }
  });

  it("lists MCP servers before the apps that need a key", async () => {
    await open(NO_KEY);
    const mcp = host.querySelector('[data-apps-mcp-section="first"]')!;
    expect(mcp.querySelector("[data-mcp-list]")).not.toBeNull();
    expect(before(mcp, host.querySelector("[data-apps-grid]")!)).toBe(true);
    expect(before(host.querySelector("[data-apps-key-steps]")!, mcp)).toBe(true);
  });

  it("puts the matching apps above MCP servers while the person searches", async () => {
    await open(NO_KEY);
    await type("Gmail");
    expect(host.querySelector('[data-apps-mcp-section="first"]')).toBeNull();
    expect(host.querySelector('[data-app-tile="gmail"]')).not.toBeNull();
    const mcp = host.querySelector("[data-apps-mcp-section]");
    if (mcp) expect(before(host.querySelector("[data-apps-grid]")!, mcp)).toBe(true);
  });

  it("offers both ways in on an empty Connected tab", async () => {
    await open(NO_KEY);
    await click(host.querySelector('[data-apps-filter="connected"]')!);
    const empty = host.querySelector('[data-apps-connected-empty="no-key"]')!;
    expect(empty.textContent).toContain(t("connectors.empty.noKeyDesc"));
    expect(host.querySelector("[data-apps-key-steps]")).toBeNull();

    await click(button(t("connectors.empty.addMcp")));
    expect(fixture.dispatched).toContainEqual({ type: "togglePlugins", open: true, surface: "mcp" });
    fixture.dispatched = [];
    await click(button(t("connectors.setup.pasteKey")));
    expect(fixture.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "connections" });
  });
});

describe("Apps with the person's own Composio key", () => {
  it("enables Connect on every app and keeps MCP servers after the apps", async () => {
    await open(OWN_KEY);
    expect(host.querySelector("[data-apps-key-steps]")).toBeNull();
    for (const slug of ["gmail", "notion"]) {
      const connect = tileAction(slug).querySelector("button")!;
      expect(connect.textContent).toBe(t("connectors.action.connect"));
      expect(connect.disabled).toBe(false);
      expect(tileAction(slug).querySelector("[data-app-needs-key]")).toBeNull();
    }
    expect(host.querySelector('[data-apps-mcp-section="last"]')).not.toBeNull();
  });

  it("takes Update your connected apps key straight to the Composio key's field", async () => {
    await open(OWN_KEY);
    await click(button(t("connectors.updateKey")));
    expect(fixture.dispatched).toContainEqual({ type: "togglePlugins", open: false });
    expect(fixture.dispatched).toContainEqual({ type: "toggleAppSettings", open: true, section: "connections" });
    expect(openKeySettings).toHaveBeenCalledWith("composio");
  });
});

describe("Apps with a connection service that is not answering", () => {
  it("warns about the service and keeps Connect off, without asking for a key on each app", async () => {
    await open(SERVICE_DOWN);
    expect(host.textContent).toContain(t("connectors.notConfigured"));
    expect(host.querySelector("[data-apps-key-steps]")).toBeNull();
    expect(tileAction("gmail").querySelector("[data-app-needs-key]")).toBeNull();
    expect(tileAction("gmail").querySelector("button")!.disabled).toBe(true);
  });
});

describe("Apps copy", () => {
  it.each([["no key", NO_KEY], ["own key", OWN_KEY], ["service down", SERVICE_DOWN]] as const)("never names MausBot (%s)", async (_, catalog) => {
    await open(catalog);
    expect(host.textContent).not.toMatch(/MausBot|self-host/i);
  });
});
