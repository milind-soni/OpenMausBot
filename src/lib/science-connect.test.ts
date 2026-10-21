import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCIENCE_TEASER, type CatalogEntry } from "../../shared/connector-catalog";
import { t } from "./i18n";
import { connectEntry, connectPublic, turnOff, type ConnectDeps } from "./science-connect";
import type { ScienceServer } from "./science-catalog";

const updateMcpServers = vi.hoisted(() => vi.fn());
vi.mock("./mcp-servers", () => ({ updateMcpServers }));

const base = "https://cloud.openmausbot.com/api/cloud/services/science";
const teaser = SCIENCE_TEASER.sections[0]!.entries;
const pub = (id: string): CatalogEntry => ({ ...teaser.find((e) => e.id === id)!, url: `${base}/${id}/mcp/` });
const benchling: CatalogEntry = { id: "benchling", name: "Benchling", group: "lab", tag: "subscription", description: "Notebooks", domain: "benchling.com", auth: "tenant", urlTemplate: "https://{tenant}.mcp.benchling.com/mcp" };
const oauthEntry: CatalogEntry = { ...pub("pubmed"), id: "someoauth", auth: "oauth", url: "https://mcp.vendor.example/mcp" };

type Call = [string, string, unknown];

function setup(opts: { servers?: ScienceServer[]; handlers?: Record<string, (body: any) => unknown> } = {}) {
  const calls: Call[] = [];
  let servers: ScienceServer[] = opts.servers ?? [];
  const listings: unknown[][] = [];
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([method, path, body]);
    const custom = opts.handlers?.[`${method} ${path}`];
    if (custom) return custom(body);
    if (method === "POST" && path === "/api/mcp/servers") {
      servers = [...servers, { name: body.name, url: body.url, enabled: false, catalog: body.catalog }];
      return { servers };
    }
    if (method === "PATCH") {
      const name = path.split("/").pop()!;
      servers = servers.map((s) => (s.name === name ? { ...s, enabled: body.enabled } : s));
      return { servers };
    }
    if (path.endsWith("/test")) return { ok: true, tools: [{ name: "x" }] };
    if (path.endsWith("/sign-in")) return { auth: { phase: "succeeded", flowId: null, authorizationUrl: null } };
    return {};
  });
  const deps: ConnectDeps = {
    api,
    open: vi.fn(async () => undefined),
    signal: new AbortController().signal,
    servers: () => servers,
    onServers: (listing) => { listings.push(listing); },
    onSignIn: vi.fn(),
  };
  return { deps, calls, listings, current: () => servers };
}

beforeEach(() => updateMcpServers.mockClear());

describe("science connect flows", () => {
  it("a public database is created with its marker, tested, then turned on", async () => {
    const { deps, calls, listings } = setup();
    expect(await connectEntry(pub("pubmed"), deps)).toEqual({ ok: true });
    expect(calls).toEqual([
      ["POST", "/api/mcp/servers", { name: "pubmed", type: "http", url: `${base}/pubmed/mcp/`, enabled: false, catalog: { id: "pubmed", auth: "cloud" } }],
      ["POST", "/api/mcp/servers/pubmed/test", undefined],
      ["PATCH", "/api/mcp/servers/pubmed", { enabled: true }],
    ]);
    expect(listings).toHaveLength(2);
    expect(updateMcpServers).toHaveBeenCalledTimes(2);
  });

  it("reuses a hand-added server", async () => {
    const { deps, calls } = setup({ servers: [{ name: "my-pubmed", url: `${base}/pubmed/mcp`, enabled: false }] });
    expect(await connectEntry(pub("pubmed"), deps)).toEqual({ ok: true });
    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual(["POST /api/mcp/servers/my-pubmed/test", "PATCH /api/mcp/servers/my-pubmed"]);
  });

  it("uses the name the server created", async () => {
    const { deps, calls } = setup({ handlers: { "POST /api/mcp/servers": (b) => ({ servers: [{ name: `x-${b.name}`, url: b.url, enabled: false, catalog: b.catalog }] }) } });
    await connectEntry(pub("pubmed"), deps);
    expect(calls[1]![1]).toBe("/api/mcp/servers/x-pubmed/test");
  });

  it("an oauth entry signs in first; a cancelled sign-in turns nothing on", async () => {
    const ok = setup();
    expect(await connectEntry(oauthEntry, ok.deps)).toEqual({ ok: true });
    expect(ok.calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /api/mcp/servers", "POST /api/mcp/servers/someoauth/sign-in", "POST /api/mcp/servers/someoauth/test", "PATCH /api/mcp/servers/someoauth",
    ]);
    const cancelled = setup({ handlers: { "POST /api/mcp/servers/someoauth/sign-in": () => ({ auth: { phase: "cancelled", flowId: null, authorizationUrl: null } }) } });
    expect(await connectEntry(oauthEntry, cancelled.deps)).toEqual({ ok: false, error: null });
    expect(cancelled.calls.some(([m, p]) => m === "PATCH" || p.endsWith("/test"))).toBe(false);
    const failed = setup({ handlers: { "POST /api/mcp/servers/someoauth/sign-in": () => ({ auth: { phase: "failed", flowId: null, authorizationUrl: null, message: "denied" } }) } });
    expect(await connectEntry(oauthEntry, failed.deps)).toEqual({ ok: false, error: "denied" });
  });

  it("a failed tool check leaves it off and says why", async () => {
    const { deps, calls } = setup({ handlers: { "POST /api/mcp/servers/pubmed/test": () => ({ ok: false, error: "boom" }) } });
    const result = await connectEntry(pub("pubmed"), deps);
    expect(result).toEqual({ ok: false, error: t("science.testFailed", { reason: "boom." }) });
    expect(calls.some(([m]) => m === "PATCH")).toBe(false);
  });

  it("a Benchling address is checked before anything is created", async () => {
    const bad = setup();
    expect(await connectEntry(benchling, bad.deps, "not a tenant!")).toEqual({ ok: false, error: t("science.tenantInvalid") });
    expect(bad.calls).toEqual([]);
    const good = setup({ handlers: { "POST /api/mcp/servers/benchling/sign-in": () => ({ auth: { phase: "succeeded", flowId: null, authorizationUrl: null } }) } });
    expect(await connectEntry(benchling, good.deps, "acme")).toEqual({ ok: true });
    expect(good.calls[0]).toEqual(["POST", "/api/mcp/servers", {
      name: "benchling", type: "http", url: "https://acme.mcp.benchling.com/mcp", enabled: false, catalog: { id: "benchling", auth: "tenant" },
    }]);
  });

  it("a refused save (managed policy) stops there", async () => {
    const { deps, calls } = setup({ handlers: { "POST /api/mcp/servers": () => { throw new Error("Blocked by your administrator."); } } });
    expect(await connectEntry(pub("pubmed"), deps)).toEqual({ ok: false, error: "Blocked by your administrator." });
    expect(calls).toHaveLength(1);
  });

  it("a locked entry has no address to connect", async () => {
    const { deps, calls } = setup();
    const locked = teaser.find((e) => e.id === "pubmed")!;
    expect(await connectEntry(locked, deps)).toEqual({ ok: false, error: t("science.noAddress") });
    expect(calls).toEqual([]);
  });

  it("Turn off disables and never deletes", async () => {
    const { deps, calls } = setup({ servers: [{ name: "pubmed", url: `${base}/pubmed/mcp/`, enabled: true }] });
    await turnOff(deps.servers()[0]!, deps);
    expect(calls).toEqual([["PATCH", "/api/mcp/servers/pubmed", { enabled: false }]]);
    expect(updateMcpServers).toHaveBeenCalledTimes(1);
  });

  it("Connect the public databases goes one at a time, skips connected ones and carries on after a failure", async () => {
    const entries = ["pubmed", "chembl", "opentargets", "clinicaltrials"].map(pub);
    const { deps, calls } = setup({
      servers: [{ name: "pubmed", url: `${base}/pubmed/mcp/`, enabled: true, catalog: { id: "pubmed", auth: "cloud" } }],
      handlers: { "POST /api/mcp/servers/chembl/test": () => ({ ok: false, error: "down", status: 503 }) },
    });
    const result = await connectPublic(entries, deps);
    expect(result).toEqual({
      pubmed: { ok: true, error: null },
      chembl: { ok: false, error: t("science.testFailed", { reason: "down." }) },
      opentargets: { ok: true, error: null },
      clinicaltrials: { ok: true, error: null },
    });
    expect(calls.filter(([m]) => m === "POST" || m === "PATCH").map(([m, p]) => `${m} ${p}`)).toEqual([
      "POST /api/mcp/servers", "POST /api/mcp/servers/chembl/test",
      "POST /api/mcp/servers", "POST /api/mcp/servers/opentargets/test", "PATCH /api/mcp/servers/opentargets",
      "POST /api/mcp/servers", "POST /api/mcp/servers/clinicaltrials/test", "PATCH /api/mcp/servers/clinicaltrials",
    ]);
  });

  it.each([
    [402, "science.needsMax"],
    [401, "science.relaySignInEnded"],
  ] as const)("a relay %i stops Connect the public databases, since every database would fail", async (status, key) => {
    const entries = ["pubmed", "chembl", "clinicaltrials"].map(pub);
    const { deps, calls } = setup({ handlers: { "POST /api/mcp/servers/pubmed/test": () => ({ ok: false, error: `The server answered HTTP ${status}.`, status }) } });
    const result = await connectPublic(entries, deps);
    expect(result).toEqual({ pubmed: { ok: false, error: t(key) } });
    expect(calls.some(([, p]) => p.includes("chembl") || p.includes("clinicaltrials"))).toBe(false);
  });

  it("a 401 from a vendor's own server is that server's alone", async () => {
    const { deps } = setup({ handlers: { "POST /api/mcp/servers/someoauth/test": () => ({ ok: false, error: "The server answered HTTP 401.", status: 401 }) } });
    expect(await connectEntry(oauthEntry, deps)).toEqual({ ok: false, error: t("science.testFailed", { reason: "The server answered HTTP 401." }) });
  });
});
