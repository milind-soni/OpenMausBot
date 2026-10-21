import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SCIENCE_TEASER, type CatalogResponse } from "../shared/connector-catalog.ts";
import type { RouteContext } from "./routes/table.ts";

const SCIENCE = "https://cloud.example.test/api/cloud/services/science";
const TOKEN = "omb_science_home";

const served: CatalogResponse = {
  version: 1,
  sections: [{
    id: "science", title: "Science", locked: false,
    groups: [{ id: "papers", title: "Papers" }],
    entries: [{ id: "pubmed", name: "PubMed", group: "papers", tag: "no-account", description: "Papers", domain: "pubmed.ncbi.nlm.nih.gov", auth: "cloud", url: "https://pubmed.example.test/mcp" }],
  }],
};

type Holder = typeof import("./connector-catalog.ts");
let holder: Holder;
let routes: typeof import("./routes/connector-catalog.ts");
let PASS: symbol;
const fetchStub = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  holder = await import("./connector-catalog.ts");
  routes = await import("./routes/connector-catalog.ts");
  PASS = (await import("./routes/table.ts")).PASS;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const message = (catalog: unknown) => ({ type: "openmausbot:science-catalog", catalog });
const homeEnv = () => {
  vi.stubEnv("OMB_CLOUD_SCIENCE_URL", SCIENCE);
  vi.stubEnv("OMB_CLOUD_SCIENCE_TOKEN", TOKEN);
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("connector catalog holder", () => {
  it("falls back to the teaser", async () => {
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: SCIENCE_TEASER, served: false });
  });

  it("a desktop's served catalog wins, locked or not; null returns to the teaser", async () => {
    expect(holder.applyScienceCatalogMessage(message(served))).toBe(true);
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: served, served: true });
    const locked = { ...served, sections: [{ ...served.sections[0]!, locked: true }] };
    holder.applyScienceCatalogMessage(message(locked));
    expect((await holder.connectorCatalog(0)).catalog.sections[0]!.locked).toBe(true);
    holder.applyScienceCatalogMessage(message(null));
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: SCIENCE_TEASER, served: false });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("a malformed catalog message throws and keeps the previous one", async () => {
    holder.applyScienceCatalogMessage(message(served));
    const before = holder.catalogRevision();
    expect(() => holder.applyScienceCatalogMessage(message({ version: 2 }))).toThrow();
    expect(() => holder.applyScienceCatalogMessage({ type: "openmausbot:science-catalog" })).toThrow();
    expect(holder.catalogRevision()).toBe(before);
    expect((await holder.connectorCatalog(0)).catalog).toEqual(served);
  });

  it("a restarted server never repeats a science revision the page already saw", async () => {
    holder.applyScienceCatalogMessage(message(served));
    const first = holder.scienceStatus().revision;
    vi.resetModules();
    const restarted: Holder = await import("./connector-catalog.ts");
    restarted.applyScienceCatalogMessage(message(served));
    expect(restarted.scienceStatus().revision).not.toBe(first);
  });

  it("other messages are not its own", () => {
    expect(holder.applyScienceCatalogMessage({ type: "openmausbot:included-x", access: null })).toBe(false);
    expect(holder.applyScienceCatalogMessage(null)).toBe(false);
  });

  it("a served catalog without a science section falls back to the teaser", async () => {
    holder.applyScienceCatalogMessage(message({ version: 1, sections: [{ id: "science", locked: "yes", groups: [], entries: [] }] }));
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: SCIENCE_TEASER, served: false });
  });

  it("a Cloud home fetches {url}/catalog with its token, at most every 10 minutes", async () => {
    homeEnv();
    fetchStub.mockImplementation(async () => reply(200, { ...served, cloudContractVersion: 3 }));
    expect(await holder.connectorCatalog(1_000)).toEqual({ catalog: served, served: true });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe(`${SCIENCE}/catalog`);
    expect(init.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(init.redirect).toBe("error");
    await holder.connectorCatalog(1_000 + 9 * 60_000);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await holder.connectorCatalog(1_000 + 10 * 60_000);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good catalog when the Cloud cannot be reached, and with none yet, the teaser", async () => {
    homeEnv();
    fetchStub.mockRejectedValueOnce(new Error("offline"));
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: SCIENCE_TEASER, served: false });
    fetchStub.mockImplementationOnce(async () => reply(200, served));
    expect((await holder.connectorCatalog(11 * 60_000)).served).toBe(true);
    fetchStub.mockRejectedValueOnce(new Error("offline"));
    expect(await holder.connectorCatalog(22 * 60_000)).toEqual({ catalog: served, served: true });
  });

  it("a 401 unauthorized from the relay keeps the last good catalog", async () => {
    homeEnv();
    fetchStub.mockImplementationOnce(async () => reply(200, served));
    await holder.connectorCatalog(0);
    fetchStub.mockImplementationOnce(async () => reply(401, { error: "unauthorized" }));
    expect(await holder.connectorCatalog(11 * 60_000)).toEqual({ catalog: served, served: true });
    fetchStub.mockImplementationOnce(async () => new Response("not json", { status: 200 }));
    expect((await holder.connectorCatalog(22 * 60_000)).catalog).toEqual(served);
  });

  it("refuses a body over 64 KiB", async () => {
    homeEnv();
    fetchStub.mockImplementationOnce(async () => new Response(JSON.stringify({ ...served, pad: "x".repeat(70_000) }), { status: 200 }));
    expect(await holder.connectorCatalog(0)).toEqual({ catalog: SCIENCE_TEASER, served: false });
  });

  it("never sends the token anywhere but the relay base", async () => {
    homeEnv();
    fetchStub.mockImplementation(async () => reply(200, served));
    await holder.connectorCatalog(0);
    await holder.connectorCatalog(11 * 60_000);
    for (const [url] of fetchStub.mock.calls) expect(String(url).startsWith(`${SCIENCE}/`)).toBe(true);
  });
});

describe("GET /api/connector-catalog", () => {
  const run = async (method: string, path: string) => {
    const headers: Record<string, string> = {};
    const sent: { status?: number; body?: unknown } = {};
    const ctx = {
      res: { setHeader: (k: string, v: string) => { headers[k] = v; } },
      path, method,
      json: (_res: unknown, status: number, body: unknown) => { sent.status = status; sent.body = body; },
    } as unknown as RouteContext;
    return { out: await routes.connectorCatalogRoutes(ctx), headers, sent };
  };

  it("answers with the catalog, never a token, and is not cached", async () => {
    homeEnv();
    fetchStub.mockImplementation(async () => reply(200, served));
    const { out, headers, sent } = await run("GET", "/api/connector-catalog");
    expect(out).toBeUndefined();
    expect(headers["cache-control"]).toBe("no-store");
    expect(sent).toEqual({ status: 200, body: { catalog: served, served: true } });
    expect(JSON.stringify(sent.body)).not.toContain(TOKEN);
  });

  it("answers only GET /api/connector-catalog", async () => {
    expect((await run("POST", "/api/connector-catalog")).out).toBe(PASS);
    expect((await run("GET", "/api/connector-catalog/x")).out).toBe(PASS);
    expect((await run("GET", "/api/config")).out).toBe(PASS);
  });
});
