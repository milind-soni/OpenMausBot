import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { callRoute } from "../routes/call-route.ts";
import { createThemeRoutes } from "./routes.ts";
import { createThemeStore } from "./store.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const ann: RequestAuth = { kind: "session", session: { id: "s-ann" } as never, via: "cookie", scopes: ["client"] };
const bob: RequestAuth = { kind: "session", session: { id: "s-bob" } as never, via: "cookie", scopes: ["client"] };
const guest: RequestAuth = { kind: "session", session: { id: "s-guest" } as never, via: "cookie", scopes: ["client"] };

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup.splice(0)) done();
});

function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "theme-routes-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = createThemeStore({ dataDir });
  const changed: Array<{ person: string; skin?: string }> = [];
  const people = new Map([["s-ann", "p_ann"], ["s-bob", "p_bob"]]);
  const routes = createThemeRoutes({
    store, changed: (person, skin) => changed.push({ person, ...(skin ? { skin } : {}) }),
    person: (auth) => (auth.kind === "session" ? people.get(auth.session.id) ?? null : "owner"),
  });
  return { store, routes, changed };
}

describe("theme routes", () => {
  it("answers each person with their own themes and tells only their windows", async () => {
    const { routes, changed } = fixture();
    expect(await callRoute(routes, { method: "PUT", path: "/api/themes/neon", body: { theme: { name: "Neon", canvas: "#0b1020" } }, auth: ann })).toMatchObject({ status: 200 });
    expect(await callRoute(routes, { method: "PUT", path: "/api/themes/active", body: { id: "neon" }, auth: ann })).toMatchObject({ status: 200 });
    expect(changed).toEqual([{ person: "p_ann" }]);
    expect(await callRoute(routes, { method: "GET", path: "/api/themes/active", auth: ann })).toMatchObject({ status: 200, body: { id: "neon", theme: { name: "Neon" } } });
    expect(await callRoute(routes, { method: "GET", path: "/api/themes", auth: bob })).toEqual({ status: 200, body: { active: null, themes: [] } });
    expect(await callRoute(routes, { method: "PUT", path: "/api/themes/active", body: { id: "neon" }, auth: bob })).toMatchObject({ status: 404 });
    expect(await callRoute(routes, { method: "GET", path: "/api/themes", auth: guest })).toMatchObject({ status: 403 });
  });

  it("refuses CSS that loads from elsewhere before saving it", async () => {
    const { routes, store } = fixture();
    const refused = await callRoute(routes, { method: "PUT", path: "/api/themes/leak", body: { theme: { name: "Leak", css: "@import url(https://example.com/x.css);" } }, auth: ann });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining("@import") } });
    expect(store.list("p_ann").themes).toEqual([]);
  });

  it("serves a theme's files to their person only, sandboxed and never sniffed", async () => {
    const { routes, store } = fixture();
    store.save("p_ann", "neon", { name: "Neon" });
    store.addAsset("p_ann", "neon", "stars.png", PNG);
    store.addAsset("p_ann", "neon", "mark.svg", SVG);
    const server: Server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const auth = req.headers["x-who"] === "bob" ? bob : ann;
      const out = await routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (typeof out === "symbol") json(res, 404, { error: "pass" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const png = await fetch(`${base}/api/theme-assets/neon/stars.png`);
    expect(png.status).toBe(200);
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    const svg = await fetch(`${base}/api/theme-assets/neon/mark.svg`);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(svg.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    const again = await fetch(`${base}/api/theme-assets/neon/stars.png`, { headers: { "if-none-match": png.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await fetch(`${base}/api/theme-assets/neon/stars.png`, { headers: { "x-who": "bob" } })).status).toBe(404);
    expect((await fetch(`${base}/api/theme-assets/neon/..%2Ftheme.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/theme-assets/neon/theme.json`)).status).toBe(404);
  });

  it("exports a theme as one file and imports it as a new one", async () => {
    const { routes, store } = fixture();
    store.save("p_ann", "neon", { name: "Neon", css: '[data-look="app"] { background: url("/api/theme-assets/neon/stars.png") }' });
    store.addAsset("p_ann", "neon", "stars.png", PNG);
    const exported = await callRoute(routes, { method: "GET", path: "/api/themes/neon/export", auth: ann });
    expect(exported.body.mausbotTheme).toBe(1);
    expect(await callRoute(routes, { method: "POST", path: "/api/themes/import", body: exported.body, auth: bob })).toEqual({ status: 200, body: { id: "neon" } });
    expect(store.asset("p_bob", "neon", "stars.png")?.bytes).toBe(PNG.byteLength);
    expect(await callRoute(routes, { method: "POST", path: "/api/themes/import", body: { mausbotTheme: 1, theme: { name: "X", css: "a{background:url(https://example.com/a)}" } }, auth: bob })).toMatchObject({ status: 400 });
    expect(await callRoute(routes, { method: "POST", path: "/api/themes/import", body: { nope: true }, auth: bob })).toMatchObject({ status: 400 });
  });
});
