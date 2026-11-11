import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PublishedApp } from "../../shared/published-apps.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import { json, readBody } from "../harness/http.ts";
import type { PublishedApps } from "../host/published-apps.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createPublishedAppsRoutes } from "./published-apps.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done)))); });

const APP: PublishedApp = { id: "netlify-mira-s1", source: "netlify", title: "Bakery", url: "https://bakery.netlify.app/", bot: { id: "mira", name: "Mira" }, publishedAt: 5, access: "public", canDelete: true };
const AUTH = { kind: "session", scopes: ["client"], session: { id: "s1", email: "ada@acme.test" } } as unknown as RequestAuth;
const VISIBLE = { marker: "ada's view" } as unknown as VisibleSet;

async function fixture() {
  const apps = {
    list: vi.fn(async () => [APP]),
    lists: vi.fn(async (_visible: VisibleSet, _auth: RequestAuth, url: string) => url.startsWith(APP.url)),
    remove: vi.fn(async (_visible: VisibleSet, _auth: RequestAuth, id: string) => id === APP.id
      ? { status: 200 as const, body: { ok: true as const } } : { status: 404 as const, body: { error: "No such published app.", code: "gone" as const } }),
  };
  const framing = vi.fn(async () => "allowed" as const);
  const routes = [createPublishedAppsRoutes({ apps: apps as unknown as PublishedApps, visibleFor: (auth) => (auth === AUTH ? VISIBLE : (undefined as never)), framing })];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: AUTH, json, readBody })
      .then((answered) => { if (!answered) json(res, 404, { error: "not routed" }); }, (error: { status?: number; message: string }) => json(res, error.status ?? 500, { error: error.message }));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { apps, framing, call };
}

describe("the Published apps routes", () => {
  it("are open to a member's session, and nothing beside them is", () => {
    for (const [method, path] of [["GET", "/api/published-apps"], ["GET", "/api/published-apps/framing"], ["POST", "/api/published-apps/delete"]] as const) {
      expect(requiredScope(method, path), `${method} ${path}`).toBe("client");
    }
    for (const [method, path] of [["POST", "/api/published-apps"], ["DELETE", "/api/published-apps/delete"], ["GET", "/api/published-apps/delete"], ["POST", "/api/published-apps/framing"],
      ["GET", "/api/published-apps/anything"], ["POST", "/api/published-pages/abcdefghijklmnopqrstuvwxyz/unpublish"], ["GET", "/api/web-panels/framing"]] as const) {
      expect(requiredScope(method, path), `${method} ${path}`).toBe("admin");
    }
  });

  it("lists what the asking viewer is shown", async () => {
    const { apps, call } = await fixture();
    expect(await call("GET", "/api/published-apps")).toEqual({ status: 200, body: { apps: [APP] } });
    expect(apps.list).toHaveBeenCalledWith(VISIBLE, AUTH);
  });

  it("checks framing only for an address in the viewer's own list", async () => {
    const { framing, call } = await fixture();
    const origin = encodeURIComponent("http://127.0.0.1:5173");
    expect(await call("GET", `/api/published-apps/framing?url=${encodeURIComponent("https://bakery.netlify.app/menu")}&origin=${origin}`)).toEqual({ status: 200, body: { framing: "allowed" } });
    expect(framing).toHaveBeenCalledWith("https://bakery.netlify.app/menu", "http://127.0.0.1:5173");
    for (const other of ["https://example.com/", "http://169.254.169.254/latest/meta-data", "http://127.0.0.1:8080/", "http://someone.netlify.app/", "https://netlify.app.evil.test/",
      "https://app.netlify.com/", "https://upload.mausbot.page/", "file:///etc/passwd", "not a url"]) {
      expect((await call("GET", `/api/published-apps/framing?url=${encodeURIComponent(other)}&origin=${origin}`)).status, other).toBe(404);
    }
    expect((await call("GET", "/api/published-apps/framing?url=https%3A%2F%2Fbakery.netlify.app%2F")).status).toBe(400);
    expect(framing).toHaveBeenCalledTimes(1);
    for (const hosted of ["https://linked-in-a-message.netlify.app/", "https://abcdefghijklmnopqrstuvwxyz.mausbot.page/report"]) {
      expect((await call("GET", `/api/published-apps/framing?url=${encodeURIComponent(hosted)}&origin=${origin}`)).status, hosted).toBe(200);
    }
    expect(framing).toHaveBeenCalledTimes(3);
  });

  it("deletes by id, passes the host's refusal through, and refuses a malformed request", async () => {
    const { apps, call } = await fixture();
    expect(await call("POST", "/api/published-apps/delete", { id: APP.id })).toEqual({ status: 200, body: { ok: true } });
    expect(apps.remove).toHaveBeenCalledWith(VISIBLE, AUTH, APP.id);
    expect(await call("POST", "/api/published-apps/delete", { id: "netlify-mira-other" })).toEqual({ status: 404, body: { error: "No such published app.", code: "gone" } });
    for (const bad of [{}, { id: "" }, { id: 7 }, { id: APP.id, token: "x" }, { id: "x".repeat(301) }]) expect((await call("POST", "/api/published-apps/delete", bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    expect(apps.remove).toHaveBeenCalledTimes(2);
  });

  it("passes on anything else", async () => {
    const { call } = await fixture();
    for (const [method, path] of [["GET", "/api/published-apps/delete"], ["POST", "/api/published-apps"], ["GET", "/api/published-pages"]] as const) {
      expect(await call(method, path), `${method} ${path}`).toEqual({ status: 404, body: { error: "not routed" } });
    }
  });
});
