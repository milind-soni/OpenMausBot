// @vitest-environment happy-dom
import { act, createElement, Fragment, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => ({
  state: { pluginsSurface: "apps", bots: [] as unknown[], instances: [] as unknown[], config: null as unknown },
  dispatch: vi.fn(),
  admin: true as boolean | null,
  services: {} as Record<string, unknown>,
  after: undefined as unknown,
  email: null as boolean | null,
}));

vi.mock("@/state/store", () => ({
  api: vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/connectors/catalog") return { cards: [{ slug: "apollo", label: "Apollo", blurb: "leads", logo: null, domain: null }], source: "api", configured: true, mode: "self-hosted" };
    if (path.endsWith("/authorize")) return { url: "https://auth.example.com/connect" };
    if (path.startsWith("/api/connectors?services=")) return { services: { apollo: fixture.after } };
    if (init?.method === "DELETE") return {};
    throw new Error(`unexpected ${path}`);
  }),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/connected-apps", () => ({
  preloadConnectedApps: vi.fn(async () => ({ services: fixture.services, authoritative: true })),
  connectorStatusMemory: () => null,
  rememberConnectorStatus: () => {},
}));
vi.mock("@/lib/connected-apps-cache", () => ({ readCachedInventory: () => null, writeCachedInventory: () => {} }));
vi.mock("@/lib/connector-oauth", () => ({
  reserveConnectionPage: () => ({ open: async () => true, cancel: () => {} }),
  reusableConnectionUrl: (page?: { url: string } | null) => page?.url ?? null,
}));
vi.mock("@/lib/product-events", () => ({ connectorConnect: vi.fn() }));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => null }));
vi.mock("./XCard", () => ({ X_CARD_SEARCH: "x", XCard: () => null }));
vi.mock("./PostizCard", () => ({ PostizCard: () => null }));
vi.mock("./EmailCard", () => ({
  EmailCard: ({ onConnection }: { onConnection: (connected: boolean | null) => void }) => {
    useEffect(() => onConnection(fixture.email), [onConnection]);
    return null;
  },
}));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { AppGrantNotice, connectAppFromBot, showAppGrantNotice } from "./AppGrantPrompt";
const { PluginsPanel } = await import("./PluginsPanel");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claude = { instanceId: "claude", capabilities: { composioMcp: true } } as unknown as InstanceInfo;
const bot = (id: string, extra: Partial<Bot> = {}) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), color: "blue", modelSelection: { instanceId: "claude", model: "m" }, ...extra }) as unknown as Bot;
const active = { connected: true, accounts: [{ id: "ca_new", status: "ACTIVE" }] };

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const open = async () => {
  await act(async () => root.render(createElement(Fragment, null, createElement(PluginsPanel), createElement(AppGrantNotice))));
  await flush();
};
const toast = () => document.body.querySelector<HTMLElement>("[data-access-toast]");
const tile = () => host.querySelector<HTMLElement>('[data-app-tile="apollo"]')!;
const button = (scope: ParentNode, label: string) => Array.from(scope.querySelectorAll("button")).find((candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label)!;
const prompt = () => host.querySelector<HTMLElement>("[data-app-grant-prompt]");
const switchOf = (name: string) => prompt()!.querySelector<HTMLElement>(`[aria-label="${name} can use Apollo"]`)!;
const click = (element: HTMLElement) => act(async () => { element.click(); });
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
/** Presses Connect, names the account, and lets one poll read the answer. */
const connectApollo = async () => {
  await click(tile().querySelector("button")!);
  await type(tile().querySelector("form input") as HTMLInputElement, "work");
  await act(async () => { tile().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush();
  await settlePoll();
};
const settlePoll = async () => {
  await act(async () => { vi.advanceTimersByTime(5_000); });
  await flush();
};
const writes = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "updateBot");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture.state = { pluginsSurface: "apps", bots: [], instances: [claude], config: null };
  fixture.dispatch.mockReset();
  fixture.admin = true;
  fixture.services = {};
  fixture.after = active;
  fixture.email = null;
  showAppGrantNotice(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("after connecting an app", () => {
  it("is already on for untouched bots, so it writes nothing and says so without asking", async () => {
    fixture.state.bots = [bot("scout"), bot("ada")];
    await open();
    await connectApollo();
    expect(prompt()).toBeNull();
    expect(writes()).toEqual([]);
    expect(toast()?.textContent).toBe("Your bots can now use Apollo.Change");
  });

  it("adds it to a bot with its own app list or tool list, by the same write as the bot's switch", async () => {
    fixture.state.bots = [
      bot("scout", { connectorScopes: { apps: { slack: "read" } } }),
      bot("ada", { connectorTools: { slack: { tools: "*" } } }),
      bot("free"),
    ];
    await open();
    await connectApollo();
    expect(writes()).toEqual([
      { type: "updateBot", botId: "scout", patch: { connectorScopes: { apps: { slack: "read", apollo: "write" } } } },
      { type: "updateBot", botId: "ada", patch: { connectorTools: { slack: { tools: "*" }, apollo: { tools: "*" } } } },
    ]);
    expect(toast()?.textContent).toContain("Your bots can now use Apollo.");
  });

  it("leaves a bot whose apps are off alone, except the bot it was started from", async () => {
    fixture.state.bots = [bot("scout", { composio: false }), bot("ada", { composio: false }), bot("free")];
    connectAppFromBot(fixture.dispatch, "ada");
    fixture.dispatch.mockClear();
    await open();
    await connectApollo();
    expect(writes()).toEqual([{ type: "updateBot", botId: "ada", patch: { composio: true, connectorScopes: { apps: { apollo: "write" } } } }]);
    expect(toast()?.textContent).toContain("Your bots can now use Apollo.");
  });

  it("says plainly when every bot's apps are off, and Change opens the switches", async () => {
    fixture.state.bots = [bot("scout", { composio: false }), bot("ada", { composio: false })];
    await open();
    await connectApollo();
    expect(writes()).toEqual([]);
    expect(toast()?.textContent).toBe("No bot uses Apollo yet.Change");
    await click(toast()!.querySelector("button")!);
    await flush();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    expect(toast()).toBeNull();
    expect(prompt()?.textContent).toContain("Which bots can use Apollo?");
    expect(switchOf("Scout").getAttribute("aria-checked")).toBe("false");
    await click(switchOf("Scout"));
    await click(button(prompt()!, "Done"));
    expect(writes()).toEqual([{ type: "updateBot", botId: "scout", patch: { composio: true, connectorScopes: { apps: { apollo: "write" } } } }]);
  });

  it("skips hidden bots and bots whose model can't use apps, and says nothing when no bot is left", async () => {
    fixture.state.bots = [
      bot("ghost", { hidden: true, connectorScopes: { apps: {} } }),
      bot("grok", { connectorScopes: { apps: {} }, modelSelection: { instanceId: "grok", model: "m" } as Bot["modelSelection"] }),
    ];
    await open();
    await connectApollo();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });

  it("writes nothing for an app the organization's rules refuse", async () => {
    fixture.state.config = { managedPolicy: { organizationName: "Acme", apps: { allowAll: false, allowlist: ["slack"] } } };
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } })];
    await open();
    expect((tile().querySelector("button") as HTMLButtonElement).disabled).toBe(true);
    const { useAppGrants } = await import("./AppGrantPrompt");
    let grants!: ReturnType<typeof useAppGrants>;
    const Probe = () => { grants = useAppGrants({ status: {}, emailConnected: null, inventoryReady: true }); return null; };
    await act(async () => root.render(createElement(Fragment, null, createElement(Probe), createElement(AppGrantNotice))));
    await act(async () => grants.appConnected("apollo", "Apollo"));
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
    await act(async () => grants.appConnected("slack", "Slack"));
    expect(writes()).toEqual([{ type: "updateBot", botId: "scout", patch: { connectorScopes: { apps: { slack: "write" } } } }]);
  });

  it("keeps the notice when the Apps pop-up closes at the same moment, and it goes away on its own", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    fixture.state.bots = [bot("scout")];
    const mounted = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
    await act(async () => root.render(createElement(Fragment, null, createElement(PluginsPanel), createElement(AppGrantNotice))));
    await mounted();
    await click(tile().querySelector("button")!);
    await type(tile().querySelector("form input") as HTMLInputElement, "work");
    await act(async () => { tile().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await mounted();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
      root.render(createElement(Fragment, null, createElement(AppGrantNotice)));
    });
    await mounted();
    expect(host.querySelector("[data-app-tile]")).toBeNull();
    expect(toast()?.textContent).toContain("Your bots can now use Apollo.");
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(toast()).toBeNull();
  });

  it("does nothing when the connection failed or was left unfinished", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } }), bot("ada")];
    await open();
    fixture.after = { connected: false, accounts: [{ id: "ca_new", status: "FAILED" }] };
    await connectApollo();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });

  it("writes nothing and says nothing on a reconnect", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } }), bot("ada")];
    fixture.services = { apollo: { connected: false, accounts: [{ id: "ca_old", status: "EXPIRED", alias: "work" }] } };
    await open();
    await click(button(tile(), "Reconnect"));
    await flush();
    await settlePoll();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });

  it("writes nothing and says nothing when a second account of a connected app is added", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } }), bot("ada")];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } };
    fixture.after = { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }, { id: "ca_new", status: "ACTIVE" }] };
    await open();
    await click(button(tile(), "Add account"));
    await type(tile().querySelector("form input") as HTMLInputElement, "second");
    await act(async () => { tile().querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    await settlePoll();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });
});

describe("changing which bots use an app", () => {
  it.each(["Close", "Escape", "the backdrop"])("changes nothing when dismissed by %s", async (how) => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } }), bot("ada", { connectorScopes: { apps: {} } })];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } };
    await open();
    await click(button(tile(), "Which bots can use Apollo?"));
    await click(switchOf("Scout"));
    if (how === "Close") await click(button(prompt()!, "Close"));
    else if (how === "Escape") await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    else await act(async () => { prompt()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(prompt()).toBeNull();
    expect(writes()).toEqual([]);
    expect(fixture.dispatch).not.toHaveBeenCalledWith({ type: "togglePlugins", open: false });
  });
});

describe("the bots using a connected app", () => {
  it("reflects each bot's scopes and changes them there, with the bot's own switch patch", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: { apollo: "write", slack: "write" } } }), bot("ada", { connectorScopes: { apps: { slack: "write" } } }), bot("off", { composio: false })];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] }, slack: { connected: true, accounts: [{ id: "ca_s", status: "ACTIVE" }] } };
    await open();
    expect(tile().textContent).toContain("Used by Scout");
    expect(tile().textContent).not.toContain("Ada");
    await click(button(tile(), "Which bots can use Apollo?"));
    expect(switchOf("Scout").getAttribute("aria-checked")).toBe("true");
    await click(switchOf("Scout"));
    await click(switchOf("Ada"));
    await click(button(prompt()!, "Done"));
    expect(writes()).toEqual([
      { type: "updateBot", botId: "scout", patch: { connectorScopes: { apps: { slack: "write" } } } },
      { type: "updateBot", botId: "ada", patch: { connectorScopes: { apps: { slack: "write", apollo: "write" } } } },
    ]);
  });

  it("says none yet, and turning off an unscoped bot keeps its other apps, email included", async () => {
    fixture.email = true;
    fixture.state.bots = [bot("off", { composio: false }), bot("all")];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] }, slack: { connected: true, accounts: [{ id: "ca_s", status: "ACTIVE" }] } };
    await open();
    expect(tile().textContent).toContain("Used by All");
    await click(button(tile(), "Which bots can use Apollo?"));
    await click(switchOf("All"));
    await click(button(prompt()!, "Done"));
    expect(writes()).toEqual([{ type: "updateBot", botId: "all", patch: { connectorScopes: { apps: { slack: "write", email: "write" } } } }]);
    fixture.state.bots = [bot("off", { composio: false })];
    fixture.dispatch.mockClear();
    await act(async () => root.render(createElement(PluginsPanel)));
    await flush();
    expect(tile().textContent).toContain("No bots yet");
  });

  it("offers no change while the inventory can't be trusted", async () => {
    const { preloadConnectedApps } = await import("@/lib/connected-apps");
    vi.mocked(preloadConnectedApps).mockImplementationOnce(async () => ({ services: fixture.services as never, authoritative: false }));
    fixture.state.bots = [bot("scout")];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } };
    await open();
    expect(tile().textContent).toContain("Used by Scout");
    expect(button(tile(), "Which bots can use Apollo?")).toBeUndefined();
  });
});

describe("on a Team Cloud", () => {
  beforeEach(() => { fixture.state.config = { team: { name: "Acme" } }; });

  it("a member can see which bots use an app but not change it, and is never asked", async () => {
    fixture.admin = false;
    fixture.state.bots = [bot("scout", { composio: false, yourAccess: "edit" }), bot("ada", { composio: false, yourAccess: "chat" })];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } };
    await open();
    expect(tile().textContent).toContain("No bots yet");
    expect(button(tile(), "Which bots can use Apollo?")).toBeUndefined();
    expect(prompt()).toBeNull();
  });

  it("writes nothing and says nothing for a member's own connection, even with one bot", async () => {
    fixture.admin = false;
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } })];
    await open();
    await connectApollo();
    expect(prompt()).toBeNull();
    expect(writes()).toEqual([]);
    expect(toast()).toBeNull();
  });

  it("gives an admin's team app to the team's bots without asking, never to a person's own helper", async () => {
    fixture.state.bots = [bot("scout", { connectorScopes: { apps: {} } }), bot("maus", { connectorScopes: { apps: {} }, defaultBot: { person: "ada@acme.test" } } as Partial<Bot>)];
    await open();
    await connectApollo();
    expect(prompt()).toBeNull();
    expect(writes()).toEqual([{ type: "updateBot", botId: "scout", patch: { connectorScopes: { apps: { apollo: "write" } } } }]);
    expect(toast()?.textContent).toContain("Your bots can now use Apollo.");
  });

  it("leaves each person's own helper out of the choice", async () => {
    fixture.state.bots = [bot("scout"), bot("maus", { defaultBot: { person: "ada@acme.test" } } as Partial<Bot>)];
    fixture.services = { apollo: { connected: true, accounts: [{ id: "ca_old", status: "ACTIVE" }] } };
    await open();
    await click(button(tile(), "Which bots can use Apollo?"));
    expect(switchOf("Maus")).toBeNull();
    expect(switchOf("Scout")).not.toBeNull();
  });
});
