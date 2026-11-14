// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOSTED_MCP_APPS, type HostedApp } from "@/lib/hosted-mcp-apps";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  runMcpSignIn: vi.fn(),
  openBotSettings: vi.fn(),
  dispatch: vi.fn(),
  store: { config: null as unknown, bots: [] as unknown[] },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: fixture.store, dispatch: fixture.dispatch }),
}));
vi.mock("@/lib/mcp-sign-in", async (original) => ({
  ...(await original<typeof import("@/lib/mcp-sign-in")>()),
  runMcpSignIn: fixture.runMcpSignIn,
}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: vi.fn(async () => {}) }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));
vi.mock("./bot-panel/panel-link", () => ({ openBotSettings: fixture.openBotSettings }));

import { openExternalLink } from "@/lib/app-links";
import { McpServersPanel } from "./McpServersPanel";

interface Listing { name: string; type: "http"; url: string; headerKeys: string[]; enabled: boolean; auth: "signed-in" | "needs-sign-in"; managedBy?: string }
const listing = (app: HostedApp, extra: Partial<Listing> = {}): Listing => ({ name: app.id, type: "http", url: app.url, headerKeys: [], enabled: false, auth: "needs-sign-in", ...extra });

let host: HTMLDivElement;
let root: Root;
let servers: Listing[];
let testRequest: { resolve: (value: unknown) => void; signal?: AbortSignal } | null;
let shown: (id: string) => boolean;
let own: { shown(server: unknown): boolean; manage(): void } | undefined;

const settle = () => act(async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); });
const card = (app: HostedApp) => host.querySelector<HTMLElement>(`[data-app-tile="${app.id}"]`)!;
const button = (app: HostedApp, label: string) => [...card(app).querySelectorAll("button")].find((element) => element.textContent?.trim() === label)!;
const calls = (method: string) => fixture.api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method)
  .map(([path, init]) => [path as string, (init as RequestInit).body ? JSON.parse((init as RequestInit).body as string) : undefined] as const);

const added = () => calls("POST").filter(([path]) => path === "/api/mcp/servers").map(([, body]) => body);

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const Cards = () => McpServersPanel({ hostedCards: { shown, onConnections: () => {}, ...(own ? { ownServers: own } : {}) } });
  await act(async () => root.render(createElement(Cards)));
  await settle();
}

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  testRequest = null;
  servers = [];
  shown = () => true;
  own = undefined;
  fixture.store = { config: null, bots: [{ id: "atlas", name: "Atlas", hidden: false }, { id: "ghost", name: "Ghost", hidden: true }] };
  fixture.runMcpSignIn.mockResolvedValue({ phase: "succeeded", flowId: "00000000-0000-4000-8000-000000000000", authorizationUrl: null });
  fixture.api.mockImplementation((path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (path === "/api/mcp/servers" && !init?.method) return Promise.resolve({ servers: structuredClone(servers) });
    // Like the real server, every answer is a fresh copy, and a listing names its headers without their values.
    const saved = ({ headers, ...entry }: { headers?: Record<string, string> } & Record<string, unknown>) => ({ ...entry, headerKeys: Object.keys(headers ?? {}).sort() });
    if (path === "/api/mcp/servers" && init?.method === "POST") {
      servers.push({ auth: "needs-sign-in", ...saved(body) } as Listing);
      return Promise.resolve({ servers: structuredClone(servers) });
    }
    const named = /^\/api\/mcp\/servers\/([^/]+)(\/sign-out|\/test)?$/.exec(path);
    const server = named && servers.find((entry) => entry.name === named[1]);
    if (server && !named[2] && init?.method === "PUT") { Object.assign(server, saved(body)); return Promise.resolve({ servers: structuredClone(servers) }); }
    if (server && !named[2] && init?.method === "DELETE") { servers = servers.filter((entry) => entry !== server); return Promise.resolve({ servers: structuredClone(servers) }); }
    if (server && named[2] === "/test") {
      return new Promise((resolve, reject) => {
        testRequest = { resolve, signal: init?.signal ?? undefined };
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (server && named[2] === "/sign-out") { server.auth = "needs-sign-in"; return Promise.resolve({ servers: structuredClone(servers) }); }
    if (server && init?.method === "PATCH") { server.enabled = body.enabled; return Promise.resolve({ servers: structuredClone(servers) }); }
    return Promise.reject(new Error(`unexpected ${init?.method ?? "GET"} ${path}`));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe.each(HOSTED_MCP_APPS.filter((app) => !("key" in app)))("The $label card", (app) => {
  async function connect() {
    await act(async () => button(app, "Connect").click());
    await settle();
  }

  describe("signing in", () => {
    beforeEach(async () => {
      servers = [listing(app)];
      await mount();
    });

    it(`says it is loading ${app.label}'s tools while the test runs, then shows why it failed in one line`, async () => {
      await connect();
      expect(testRequest).not.toBeNull();
      expect(card(app).querySelector('[role="status"]')?.textContent).toContain(`Signed in. Loading ${app.label}’s tools…`);
      expect(card(app).textContent).not.toContain("Waiting");
      expect(button(app, "Cancel")).toBeTruthy();

      await act(async () => testRequest!.resolve({ ok: false, error: "The server did not answer in time." }));
      await settle();

      expect([...card(app).querySelectorAll('[role="alert"]')].map((element) => element.textContent)).toEqual([
        `Signed in, but ${app.label}’s tools could not be loaded: The server did not answer in time. Please connect again to retry.`,
      ]);
      expect(calls("PATCH")).toEqual([]);
      expect(button(app, "Connect")).toBeTruthy();
    });

    it("keeps the reason when the test request itself is refused", async () => {
      await connect();
      await act(async () => { testRequest!.resolve(Promise.reject(new Error("Two MCP connection tests are already running."))); });
      await settle();
      expect(card(app).querySelector('[role="alert"]')?.textContent)
        .toBe(`Signed in, but ${app.label}’s tools could not be loaded: Two MCP connection tests are already running. Please connect again to retry.`);
    });

    it("ends a reason that has no period of its own, like a proxy's 504", async () => {
      await connect();
      await act(async () => { testRequest!.resolve(Promise.reject(new Error("504 Gateway Timeout"))); });
      await settle();
      expect(card(app).querySelector('[role="alert"]')?.textContent)
        .toBe(`Signed in, but ${app.label}’s tools could not be loaded: 504 Gateway Timeout. Please connect again to retry.`);
    });

    it("closes the test request when the person cancels", async () => {
      await connect();
      expect(testRequest?.signal?.aborted).toBe(false);
      await act(async () => button(app, "Cancel").click());
      await settle();
      expect(testRequest?.signal?.aborted).toBe(true);
      expect(card(app).querySelector('[role="alert"]')).toBeNull();
    });

    it("turns the server on once its tools load", async () => {
      await connect();
      await act(async () => testRequest!.resolve({ ok: true, tools: [{ name: "any" }] }));
      await settle();
      expect(calls("PATCH")).toEqual([[`/api/mcp/servers/${app.id}`, { enabled: true }]]);
    });

    it("leaves the other hosted apps' buttons alone while this one signs in", async () => {
      await connect();
      for (const other of HOSTED_MCP_APPS.filter((candidate) => candidate !== app)) {
        expect(button(other, "Cancel")).toBeUndefined();
        expect(card(other).querySelector("button")!.disabled).toBe(true);
      }
    });
  });

  it("adds the server at its official address without testing it first, then signs in", async () => {
    await mount();
    await connect();
    expect(added()).toEqual([{ name: app.id, type: "http", url: app.url, enabled: false }]);
    expect(fixture.runMcpSignIn).toHaveBeenCalledWith(app.id, expect.anything());
    const testCall = fixture.api.mock.calls.findIndex(([path]) => path === `/api/mcp/servers/${app.id}/test`);
    expect(fixture.api.mock.invocationCallOrder[testCall]).toBeGreaterThan(fixture.runMcpSignIn.mock.invocationCallOrder[0]!);
  });

  it("shows a failed save on its own card only", async () => {
    await mount();
    const save = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation((path: string, init?: RequestInit) => init?.method === "POST" && path === "/api/mcp/servers"
      ? Promise.reject(new Error("Synthetic save failure"))
      : save(path, init));
    await connect();
    expect([...card(app).querySelectorAll('[role="alert"]')].map((element) => element.textContent)).toEqual(["Synthetic save failure"]);
    for (const other of HOSTED_MCP_APPS.filter((candidate) => candidate !== app)) expect(card(other).querySelector('[role="alert"]')).toBeNull();
  });

  it("signs in to the server it already has, under any name, instead of adding another", async () => {
    servers = [listing(app, { name: "business" })];
    await mount();
    await connect();
    expect(added()).toEqual([]);
    expect(fixture.runMcpSignIn).toHaveBeenCalledWith("business", expect.anything());
  });

  it("turns the server off before signing out", async () => {
    servers = [listing(app, { enabled: true, auth: "signed-in" })];
    await mount();
    expect(card(app).querySelector('[aria-label="Connected"]')).not.toBeNull();
    await act(async () => button(app, "Disconnect").click());
    await settle();
    expect(fixture.api.mock.calls.map(([path]) => path).slice(-2)).toEqual([`/api/mcp/servers/${app.id}`, `/api/mcp/servers/${app.id}/sign-out`]);
    expect(calls("PATCH")).toEqual([[`/api/mcp/servers/${app.id}`, { enabled: false }]]);
  });

  it("cannot connect a server the organization manages or a policy that allows no custom servers", async () => {
    servers = [listing(app, { managedBy: "Acme" })];
    await mount();
    expect((button(app, "Connect") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => root.unmount());
    host.remove();
    servers = [];
    fixture.store = { ...fixture.store, config: { managedPolicy: { organizationName: "Acme", mcp: { allowCustom: false, allowlist: [] } } } };
    await mount();
    expect((button(app, "Connect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens each visible bot's Access settings on its MCP page from Bot access", async () => {
    await mount();
    const buttons = [...card(app).querySelectorAll("details button")];
    expect(buttons.map((element) => element.textContent)).toEqual(["Manage Atlas’s access"]);
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: false });
    expect(fixture.openBotSettings).toHaveBeenCalledWith(fixture.dispatch, "access", { botId: "atlas", page: "mcp" });
  });

  it("shows its logo, or its glyph and no image when the service publishes no logo we may ship", async () => {
    await mount();
    expect(card(app).querySelector("img") !== null).toBe("image" in app.icon);
    expect(card(app).querySelector("svg") !== null).toBe("glyph" in app.icon);
  });
});

describe.each(HOSTED_MCP_APPS.filter((app) => "key" in app))("The $label key card", (app) => {
  const keyField = () => card(app).querySelector<HTMLInputElement>('input[type="password"]')!;
  async function typeKey(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(keyField(), value);
      keyField().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function connectWith(value: string) {
    await typeKey(value);
    await act(async () => button(app, "Connect").click());
    await settle();
  }

  it("keeps Connect off until a key is typed", async () => {
    await mount();
    expect(keyField().getAttribute("aria-label")).toBe(`${app.label} API key`);
    expect((button(app, "Connect") as HTMLButtonElement).disabled).toBe(true);
    await typeKey("  ");
    expect((button(app, "Connect") as HTMLButtonElement).disabled).toBe(true);
    await typeKey("sk-live");
    expect((button(app, "Connect") as HTMLButtonElement).disabled).toBe(false);
  });

  it("saves the key in a header on a server left off, never in its address, and switches it on once its tools load", async () => {
    await mount();
    await connectWith(" sk-live ");
    expect(added()).toEqual([{ name: app.id, type: "http", url: app.url, headers: { Authorization: "Bearer sk-live" }, enabled: false }]);
    expect(fixture.runMcpSignIn).not.toHaveBeenCalled();
    expect(calls("PATCH")).toEqual([]);
    await act(async () => testRequest!.resolve({ ok: true, tools: [{ name: "any" }] }));
    await settle();
    expect(calls("PATCH")).toEqual([[`/api/mcp/servers/${app.id}`, { enabled: true }]]);
    expect(card(app).querySelector('[aria-label="Connected"]')).not.toBeNull();
    expect(card(app).querySelector('input[type="password"]')).toBeNull();
  });

  it("leaves the server off and says the key was refused when the service turns it down", async () => {
    await mount();
    await connectWith("sk-wrong");
    await act(async () => testRequest!.resolve({ ok: false, reason: "keys", error: "The server didn't accept the keys (HTTP 401). Check the header values." }));
    await settle();
    expect(card(app).querySelector('[role="alert"]')?.textContent).toBe(`${app.label} didn’t accept that key. Check it and connect again.`);
    expect(calls("PATCH")).toEqual([]);
    expect(card(app).querySelector('[aria-label="Connected"]')).toBeNull();
  });

  it("leaves the server off and gives the reason when its tools fail to load for anything else", async () => {
    await mount();
    await connectWith("sk-live");
    await act(async () => testRequest!.resolve({ ok: false, reason: "timeout", error: "The server did not answer in time." }));
    await settle();
    expect(card(app).querySelector('[role="alert"]')?.textContent).toBe(`${app.label}’s tools could not be loaded with that key: The server did not answer in time. Connect again to retry.`);
    expect(calls("PATCH")).toEqual([]);
  });

  it("replaces the key on the server it already has, under any name, instead of adding another", async () => {
    servers = [listing(app, { name: "calls", headerKeys: ["Authorization"] })];
    await mount();
    await connectWith("sk-new");
    expect(added()).toEqual([]);
    expect(calls("PUT")).toEqual([["/api/mcp/servers/calls", { type: "http", url: app.url, headers: { Authorization: "Bearer sk-new" }, enabled: false }]]);
  });

  it("deletes the server, and with it the key, on Disconnect", async () => {
    servers = [listing(app, { enabled: true, headerKeys: ["Authorization"] })];
    await mount();
    expect(card(app).querySelector('[aria-label="Connected"]')).not.toBeNull();
    await act(async () => button(app, "Disconnect").click());
    await settle();
    expect(calls("DELETE")).toEqual([[`/api/mcp/servers/${app.id}`, undefined]]);
    expect(fixture.api.mock.calls.some(([path]) => String(path).endsWith("/sign-out"))).toBe(false);
    expect(keyField()).not.toBeNull();
  });

  it("opens the service's own page for making a key", async () => {
    await mount();
    await act(async () => button(app, `Get a ${app.label} key`).click());
    expect(openExternalLink).toHaveBeenCalledWith(app.key.url);
  });
});

describe("the Agentcard tile", () => {
  it("draws a glyph and never an Agentcard logo, and says Agentcard keeps the cards", async () => {
    await mount();
    const tile = card(HOSTED_MCP_APPS.find((app) => app.id === "agentcard")!);
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.textContent).toContain("Shop and pay from your own Agentcard account.");
    expect(tile.textContent).toContain("OpenMausBot stores no card details");
  });
});

describe("hosted MCP list availability", () => {
  it("shows one list error and restores app cards after retry", async () => {
    fixture.api.mockRejectedValueOnce(new Error("no route: GET /api/mcp/servers"));
    await mount();
    const alerts = [...host.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain("Couldn't load MCP apps");
    expect(alerts[0]!.textContent).toContain("no route: GET /api/mcp/servers");
    expect(host.querySelector("[data-app-tile]")).toBeNull();
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Retry");
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await settle();
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelectorAll("[data-app-tile]")).toHaveLength(HOSTED_MCP_APPS.length);
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/mcp/servers")).toHaveLength(2);
  });
});

describe("hiding a hosted card", () => {
  it("keeps it mounted and loads the servers once for every card", async () => {
    const [kept, ...others] = HOSTED_MCP_APPS;
    shown = (id) => id === kept.id;
    await mount();
    expect(card(kept).parentElement!.className).toBe("contents");
    for (const other of others) {
      expect(card(other)).not.toBeNull();
      expect(card(other).parentElement!.className).toBe("hidden");
    }
    expect(fixture.api.mock.calls.filter(([path]) => path === "/api/mcp/servers")).toHaveLength(1);
  });
});

describe("the person's own MCP servers in the Connected view", () => {
  const remote = (name: string, extra: Record<string, unknown> = {}) => ({ name, type: "http" as const, url: `https://${name}.example/mcp`, headerKeys: [], enabled: true, ...extra }) as unknown as Listing;
  const tile = (name: string) => host.querySelector<HTMLElement>(`[data-mcp-tile][data-app-tile="${name}"]`);

  beforeEach(() => { own = { shown: () => true, manage: vi.fn() }; });

  it("lists each switched-on server as a tile, and leaves out the ones that are off and every hosted app's", async () => {
    servers = [remote("docs"), { ...remote("off"), enabled: false }, listing(HOSTED_MCP_APPS[0]!, { enabled: true, auth: "signed-in" }), remote("postiz")];
    await mount();
    expect(tile("docs")!.textContent).toContain("docs");
    expect(tile("docs")!.querySelector('[aria-label="Connected"]')).not.toBeNull();
    expect(tile("off")).toBeNull();
    expect(tile(HOSTED_MCP_APPS[0]!.id)).toBeNull();
    expect(host.querySelectorAll(`[data-app-tile="${HOSTED_MCP_APPS[0]!.id}"]`)).toHaveLength(1);
    expect(tile("postiz")).toBeNull();
  });

  it("lists a command-line server too", async () => {
    servers = [{ name: "local", command: "npx", args: ["pkg"], envKeys: [], enabled: true } as unknown as Listing];
    await mount();
    expect(tile("local")!.textContent).toContain("npx pkg");
  });

  it("lists one that needs a sign-in with its plain status and a way to sign in, but not as connected", async () => {
    servers = [remote("docs", { auth: "needs-sign-in" })];
    await mount();
    expect(tile("docs")!.textContent).toContain("Needs sign-in");
    expect(tile("docs")!.querySelector('[aria-label="Connected"]')).toBeNull();
    await act(async () => { [...tile("docs")!.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Sign in")!.click(); });
    await settle();
    expect(fixture.runMcpSignIn).toHaveBeenCalledOnce();
  });

  it("names the bots it is off for, and hands editing to the MCP servers view", async () => {
    fixture.store.bots = [{ id: "atlas", name: "Atlas", hidden: false }];
    servers = [remote("docs", { offFor: ["atlas"] })];
    await mount();
    expect(tile("docs")!.textContent).toContain("Atlas");
    await act(async () => { [...tile("docs")!.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Manage")!.click(); });
    expect(own!.manage).toHaveBeenCalledOnce();
  });

  it("leaves out what a search doesn't match, and shows none outside the Connected view", async () => {
    servers = [remote("docs"), remote("wiki")];
    own = { shown: (server) => (server as Listing).name === "wiki", manage: vi.fn() };
    await mount();
    expect(tile("docs")).toBeNull();
    expect(tile("wiki")).not.toBeNull();
    act(() => root.unmount());
    host.remove();
    own = undefined;
    await mount();
    expect(host.querySelector("[data-mcp-tile]")).toBeNull();
  });
});
