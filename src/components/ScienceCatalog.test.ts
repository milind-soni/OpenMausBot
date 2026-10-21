// @vitest-environment happy-dom
import { StrictMode, act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCIENCE_TEASER, type CatalogEntry, type CatalogResponse } from "../../shared/connector-catalog";
import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return {
    api: vi.fn(),
    dispatch: vi.fn(),
    state: { bots: [] as unknown[], config: { science: { revision: "boot.1" } } },
    openExternalLink: vi.fn(async (_url: string) => {}),
    openBotSettings: vi.fn(),
  };
});
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) }));
vi.mock("@/lib/app-links", () => ({ openExternalLink: fixture.openExternalLink }));
vi.mock("@/lib/mcp-servers", () => ({ updateMcpServers: vi.fn() }));
vi.mock("./bot-panel/panel-link", () => ({ openBotSettings: fixture.openBotSettings }));
vi.mock("./GetMaxButton", () => ({ GetMaxButton: () => createElement("button", { "data-get-max": "" }, "Get Max") }));

import { ScienceCatalog, forgetServedScience } from "./ScienceCatalog";

const cloud = (id: string, name: string, group: string, domain: string): CatalogEntry => ({
  id, name, group, tag: "no-account", description: `${name} description`, domain, auth: "cloud", url: `https://relay.example/${id}/mcp`,
});
const oauth = (id: string, name: string, group: string, domain: string): CatalogEntry => ({
  id, name, group, tag: "free-account", description: `${name} description`, domain, auth: "oauth", url: `https://${domain}/mcp`,
});
const served: CatalogResponse = {
  version: 1,
  sections: [{
    id: "science", title: "Science", locked: false,
    groups: SCIENCE_TEASER.sections[0]!.groups,
    entries: [
      cloud("pubmed", "PubMed", "papers", "pubmed.ncbi.nlm.nih.gov"),
      cloud("biorxiv", "bioRxiv and medRxiv", "papers", "biorxiv.org"),
      oauth("consensus", "Consensus", "papers", "consensus.app"),
      cloud("chembl", "ChEMBL", "targets", "chembl.gitbook.io"),
      cloud("opentargets", "Open Targets", "targets", "platform.opentargets.org"),
      cloud("clinicaltrials", "Clinical Trials", "clinical", "clinicaltrials.gov"),
      { id: "benchling", name: "Benchling", group: "lab", tag: "subscription", description: "Your notebook", domain: "benchling.com", auth: "tenant", urlTemplate: "https://{tenant}.mcp.benchling.com/mcp" },
      oauth("biorender", "BioRender", "lab", "biorender.com"),
    ],
  }],
};
const withoutUrl: CatalogResponse = {
  version: 1,
  sections: [{ ...served.sections[0]!, entries: served.sections[0]!.entries.map((e) => (e.id === "pubmed" ? { ...e, url: undefined } : e)) }],
};

interface Listing { name: string; type: string; url: string; enabled: boolean; auth?: string; catalog?: { id: string; auth: string } }
let servers: Listing[];
let catalog: CatalogResponse;
let calls: Array<[string, string, any]>;
let host: HTMLDivElement;
let root: Root;
const callbacks = { onViewAll: vi.fn(), onConnections: vi.fn(), onServersChanged: vi.fn() };

type Props = { view?: "science" | "all" | "connected" | "hidden"; search?: string };
const settle = () => act(async () => { for (let turn = 0; turn < 60; turn += 1) await Promise.resolve(); });
const buttons = () => [...host.querySelectorAll("button")];
const button = (label: string, within: ParentNode = host) => [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const tile = (id: string) => host.querySelector<HTMLElement>(`[data-app-tile="${id}"]`)!;
const mutations = () => calls.filter(([method]) => method !== "GET");

function serve() {
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push([method, path, body]);
    if (path === "/api/connector-catalog") return { catalog, served: true };
    if (path === "/api/mcp/servers" && method === "GET") return { servers };
    if (path === "/api/mcp/servers" && method === "POST") {
      servers.push({ ...body, auth: body.catalog.auth === "cloud" ? "signed-in" : "needs-sign-in" });
      return { servers };
    }
    const named = /^\/api\/mcp\/servers\/([^/]+)(\/.*)?$/.exec(path);
    if (named) {
      const server = servers.find((s) => s.name === decodeURIComponent(named[1]!))!;
      if (!named[2] && method === "PATCH") { server.enabled = body.enabled; return { servers }; }
      if (named[2] === "/test") return { ok: true };
      if (named[2] === "/sign-in" && method === "POST") return { auth: { phase: "waiting", flowId: "flow-1", authorizationUrl: "https://auth.example/consent" } };
      if (named[2]?.startsWith("/sign-in/") && method === "DELETE") return {};
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
}

const element = (props: Props) => createElement(ScienceCatalog, { view: "science", search: "", ...props, ...callbacks });

async function mount(props: Props = {}, strict = false) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(strict ? createElement(StrictMode, null, element(props)) : element(props)));
  await settle();
}
const container = (section: string) => host.querySelector(`[data-apps-section="${section}"]`)!.closest<HTMLElement>('[class~="@container"]');

beforeEach(() => {
  setLocale("en");
  forgetServedScience();
  servers = [];
  catalog = served;
  calls = [];
  fixture.state = { bots: [], config: { science: { revision: "boot.1" } } };
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
  fixture.openExternalLink.mockClear();
  fixture.openBotSettings.mockClear();
  Object.values(callbacks).forEach((fn) => fn.mockReset());
  serve();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ScienceCatalog", () => {
  it("the teaser greys every Connect and offers Max", async () => {
    catalog = SCIENCE_TEASER;
    await mount();
    expect([...host.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Papers and preprints", "Targets and chemistry", "Clinical and regulatory", "Lab, data and figures"]);
    const connects = buttons().filter((b) => b.textContent?.trim() === "Connect");
    expect(connects.length).toBe(10);
    expect(connects.every((b) => b.disabled)).toBe(true);
    expect(host.textContent).toContain("Science sources come with Max.");
    expect(host.querySelector("[data-get-max]")).not.toBeNull();
  });

  it("Connect the 5 public databases connects them in order", async () => {
    await mount();
    expect(host.textContent).toContain("5 public databases run on MausBot Cloud");
    await act(async () => button("Connect the 5 public databases")!.click());
    await settle();
    const created = mutations().filter(([m, p]) => m === "POST" && p === "/api/mcp/servers").map(([, , body]) => body.catalog.id);
    expect(created).toEqual(["pubmed", "biorxiv", "chembl", "opentargets", "clinicaltrials"]);
    expect(mutations().filter(([m, , b]) => m === "PATCH" && b.enabled === true)).toHaveLength(5);
    expect(mutations().filter(([, p]) => p.endsWith("/test"))).toHaveLength(5);
    const done = button("Public databases connected")!;
    expect(done.disabled).toBe(true);
    expect(callbacks.onConnections.mock.lastCall![0].map((c: { id: string }) => c.id)).toHaveLength(5);
    expect(callbacks.onServersChanged).toHaveBeenCalled();
  });

  it("Connect the public databases carries on past a failure and marks the tile that failed", async () => {
    await mount();
    const base = fixture.api.getMockImplementation()!;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => (path === "/api/mcp/servers/chembl/test" ? { ok: false, error: "down" } : base(path, init)));
    await act(async () => button("Connect the 5 public databases")!.click());
    await settle();
    const enabled = mutations().filter(([m, , b]) => m === "PATCH" && b.enabled === true).map(([, p]) => p.split("/").pop());
    expect(enabled).toEqual(["pubmed", "biorxiv", "opentargets", "clinicaltrials"]);
    expect(tile("chembl").querySelector('[role="alert"]')!.textContent).toContain("down.");
    expect(button("Connect the last public database")!.disabled).toBe(false);
  });

  it("switches from teaser to served without remounting", async () => {
    catalog = SCIENCE_TEASER;
    await mount({ search: "pub" });
    const before = tile("pubmed");
    expect(button("Connect", before)!.disabled).toBe(true);
    catalog = served;
    fixture.state = { bots: [], config: { science: { revision: "boot.2" } } };
    await act(async () => root.render(element({ search: "pub" })));
    await settle();
    expect(tile("pubmed")).toBe(before);
    expect(button("Connect", before)!.disabled).toBe(false);
    expect(host.querySelectorAll("[data-app-tile]")).toHaveLength(1);
  });

  it("an oauth tile waits on the browser", async () => {
    await mount();
    await act(async () => button("Connect", tile("consensus"))!.click());
    await settle();
    expect(tile("consensus").textContent).toContain("Finish setup in your browser");
    expect(fixture.openExternalLink).toHaveBeenLastCalledWith("https://auth.example/consent");
    fixture.openExternalLink.mockClear();
    await act(async () => button("Continue", tile("consensus"))!.click());
    expect(fixture.openExternalLink).toHaveBeenCalledWith("https://auth.example/consent");
    expect([...tile("consensus").querySelectorAll("a")].some((a) => a.textContent === "Open authorization page")).toBe(true);
  });

  it("Benchling asks for the company address first", async () => {
    await mount();
    await act(async () => button("Connect", tile("benchling"))!.click());
    const input = tile("benchling").querySelector("input")!;
    expect(input.placeholder).toBe("Your Benchling address, like acme.benchling.com");
    expect(tile("benchling").textContent).toContain("An admin must turn on Benchling AI for your tenant first.");
    const submit = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => tile("benchling").querySelector("form")!.requestSubmit());
      await settle();
    };
    await submit("not a valid address!");
    expect(tile("benchling").querySelector('[role="alert"]')!.textContent).toContain("Enter your Benchling name");
    expect(mutations()).toHaveLength(0);
    await submit("acme.benchling.com");
    expect(mutations()[0]![2]).toMatchObject({ name: "benchling", url: "https://acme.mcp.benchling.com/mcp", catalog: { id: "benchling", auth: "tenant" } });
  });

  it("a connected tile offers Turn off and Bot access", async () => {
    servers = [{ name: "pubmed", type: "http", url: "https://relay.example/pubmed/mcp", enabled: true, auth: "signed-in", catalog: { id: "pubmed", auth: "cloud" } }];
    fixture.state = { bots: [{ id: "b1", name: "Pepper" }, { id: "b2", name: "Gone", hidden: true }], config: { science: { revision: "boot.1" } } };
    await mount();
    const pubmed = tile("pubmed");
    expect(pubmed.querySelector('[aria-label="Connected"]')).not.toBeNull();
    expect(pubmed.textContent).toContain("Bot access");
    expect(pubmed.textContent).toContain("Bots using every enabled MCP server can use PubMed now.");
    expect(button("Manage Gone’s access", pubmed)).toBeUndefined();
    await act(async () => button("Manage Pepper’s access", pubmed)!.click());
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "togglePlugins", open: false });
    expect(fixture.openBotSettings).toHaveBeenCalledWith(fixture.dispatch, "access", { botId: "b1", page: "mcp" });
    await act(async () => button("Turn off", pubmed)!.click());
    await settle();
    expect(mutations()).toEqual([["PATCH", "/api/mcp/servers/pubmed", { enabled: false }]]);
    expect(tile("pubmed").querySelector('[aria-label="Connected"]')).toBeNull();
  });

  it("search filters and says when nothing matches", async () => {
    await mount({ search: "biorxiv" });
    expect([...host.querySelectorAll("[data-app-tile]")].map((t) => t.getAttribute("data-app-tile"))).toEqual(["biorxiv"]);
    expect(host.textContent).not.toContain("public databases run on");
    await act(async () => root.render(element({ search: "zzz" })));
    expect(host.textContent).toContain("No science sources match.");
    expect(host.querySelectorAll("[data-app-tile]")).toHaveLength(0);
  });

  it("the All view shows four tiles and View all", async () => {
    await mount({ view: "all" });
    expect([...host.querySelectorAll("[data-app-tile]")].map((t) => t.getAttribute("data-app-tile"))).toEqual(["pubmed", "chembl", "clinicaltrials", "biorender"]);
    expect(host.querySelector("h3")!.textContent).toBe("Science");
    await act(async () => button("View all")!.click());
    expect(callbacks.onViewAll).toHaveBeenCalledTimes(1);
    await act(async () => root.render(element({ view: "all", search: "bio" })));
    expect(button("View all")).toBeUndefined();
    expect([...host.querySelectorAll("[data-app-tile]")].map((t) => t.getAttribute("data-app-tile"))).toEqual(["biorxiv", "biorender"]);
    await act(async () => root.render(element({ view: "all", search: "zzz" })));
    expect(host.textContent).toBe("");
  });

  it("the Connected view lists only connected sources", async () => {
    servers = [{ name: "chembl", type: "http", url: "https://relay.example/chembl/mcp", enabled: true, auth: "signed-in", catalog: { id: "chembl", auth: "cloud" } }];
    await mount({ view: "connected" });
    expect([...host.querySelectorAll("[data-app-tile]")].map((t) => t.getAttribute("data-app-tile"))).toEqual(["chembl"]);
  });

  it.each([["all", "science-all"], ["connected", "science-connected"]] as const)("the %s view's section sits in a sized grid spaced like the sections below it", async (view, section) => {
    servers = [{ name: "chembl", type: "http", url: "https://relay.example/chembl/mcp", enabled: true, auth: "signed-in", catalog: { id: "chembl", auth: "cloud" } }];
    await mount({ view });
    const grid = container(section);
    expect(grid).not.toBeNull();
    expect(grid!.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-col", "gap-7", "pt-1", "mb-7"]));
  });

  it("connects, turns off and connects all under StrictMode", async () => {
    await mount({}, true);
    await act(async () => button("Connect", tile("pubmed"))!.click());
    await settle();
    expect(tile("pubmed").querySelector('[aria-label="Connected"]')).not.toBeNull();
    await act(async () => button("Turn off", tile("pubmed"))!.click());
    await settle();
    expect(tile("pubmed").querySelector('[aria-label="Connected"]')).toBeNull();
    expect(button("Connect", tile("pubmed"))!.disabled).toBe(false);
    await act(async () => button("Connect the 5 public databases")!.click());
    await settle();
    expect(button("Public databases connected")!.disabled).toBe(true);
    expect(mutations().filter(([m, , b]) => m === "PATCH" && b.enabled === true)).toHaveLength(6);
  });

  it("hidden still reports connections", async () => {
    servers = [{ name: "pubmed", type: "http", url: "https://relay.example/pubmed/mcp", enabled: true, auth: "signed-in", catalog: { id: "pubmed", auth: "cloud" } }];
    await mount({ view: "hidden" });
    expect(host.textContent).toBe("");
    expect(callbacks.onConnections).toHaveBeenLastCalledWith([{ id: "pubmed", name: "PubMed", domain: "pubmed.ncbi.nlm.nih.gov" }]);
  });

  it("after Max ends a stored public database reads Needs Max and is left alone", async () => {
    catalog = SCIENCE_TEASER;
    servers = [{ name: "pubmed", type: "http", url: "https://relay.example/pubmed/mcp", enabled: true, auth: "needs-max", catalog: { id: "pubmed", auth: "cloud" } }];
    await mount();
    expect(tile("pubmed").textContent).toContain("Needs Max");
    expect(button("Connect", tile("pubmed"))!.disabled).toBe(true);
    expect(tile("chembl").textContent).not.toContain("Needs Max");
    expect(mutations()).toHaveLength(0);
    expect(callbacks.onConnections).toHaveBeenLastCalledWith([]);
  });

  it("an unlocked cloud entry without an address is unavailable", async () => {
    catalog = withoutUrl;
    await mount();
    expect(button("Connect", tile("pubmed"))!.disabled).toBe(true);
    expect(button("Connect the 4 public databases")).toBeDefined();
  });

  it("shows no upsell before the first response, and keeps the served catalog across mounts", async () => {
    let release!: () => void;
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/mcp/servers") return { servers };
      await new Promise<void>((resolve) => { release = resolve; });
      return { catalog: served, served: true };
    });
    await mount();
    expect(host.textContent).not.toContain("Science sources come with Max.");
    expect(host.querySelector("[data-get-max]")).toBeNull();
    await act(async () => release());
    await settle();
    expect(host.textContent).toContain("public databases run on MausBot Cloud");
    await act(async () => root.unmount());
    host.remove();
    fixture.api.mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(host.textContent).toContain("public databases run on MausBot Cloud");
    expect(host.textContent).not.toContain("Science sources come with Max.");
  });

  it("keeps the served catalog on a same-revision remount even when the refetch fails", async () => {
    await mount();
    await act(async () => root.unmount());
    host.remove();
    fixture.api.mockImplementation(async () => { throw new Error("offline"); });
    await mount();
    expect(host.textContent).toContain("public databases run on MausBot Cloud");
    expect(host.textContent).not.toContain("Science sources come with Max.");
  });

  it("disables Turn off while the PATCH is in flight", async () => {
    servers = [{ name: "pubmed", type: "http", url: "https://relay.example/pubmed/mcp", enabled: true, auth: "signed-in", catalog: { id: "pubmed", auth: "cloud" } }];
    await mount();
    const base = fixture.api.getMockImplementation()!;
    let finish!: () => void;
    fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") await new Promise<void>((resolve) => { finish = resolve; });
      return base(path, init);
    });
    await act(async () => button("Turn off", tile("pubmed"))!.click());
    expect(tile("pubmed").querySelectorAll("button")[0]!.disabled).toBe(true);
    expect(button("Turn off", tile("pubmed"))).toBeUndefined();
    await act(async () => finish());
    await settle();
    expect(mutations().filter(([m]) => m === "PATCH")).toHaveLength(1);
  });

  it("flips Needs Max when access arrives and the revision bumps", async () => {
    catalog = SCIENCE_TEASER;
    servers = [{ name: "pubmed", type: "http", url: "https://relay.example/pubmed/mcp", enabled: true, auth: "needs-max", catalog: { id: "pubmed", auth: "cloud" } }];
    await mount();
    expect(tile("pubmed").textContent).toContain("Needs Max");
    catalog = served;
    servers[0]!.auth = "signed-in";
    fixture.state = { bots: [], config: { science: { revision: "boot.2" } } };
    await act(async () => root.render(element({})));
    await settle();
    expect(tile("pubmed").textContent).not.toContain("Needs Max");
  });

  it("never shows the old unlocked catalog after a revision bump when the refetch fails", async () => {
    await mount();
    await act(async () => root.unmount());
    host.remove();
    fixture.api.mockImplementation(async (path: string) => { if (path === "/api/mcp/servers") return { servers }; throw new Error("offline"); });
    fixture.state = { bots: [], config: { science: { revision: "boot.2" } } };
    await mount();
    expect(host.textContent).toContain("Science sources come with Max.");
    expect(buttons().filter((b) => b.textContent?.trim() === "Connect").every((b) => b.disabled)).toBe(true);
  });

  it("treats a response without a Science section after a revision bump as locked", async () => {
    await mount();
    catalog = { version: 1, sections: [] };
    fixture.state = { bots: [], config: { science: { revision: "boot.2" } } };
    await act(async () => root.render(element({})));
    await settle();
    expect(host.textContent).toContain("Science sources come with Max.");
    expect(buttons().filter((b) => b.textContent?.trim() === "Connect").every((b) => b.disabled)).toBe(true);
  });

  it("renders nothing on the Connected view while pending", async () => {
    fixture.api.mockImplementation(() => new Promise(() => {}));
    await mount({ view: "connected" });
    expect(host.textContent).toBe("");
  });
});
