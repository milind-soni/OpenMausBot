import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createCursorSession, type CursorSession } from "../cursor-session.ts";
import { requiredScope } from "../request-auth.ts";
import { dispatchRoutes } from "./table.ts";
import { createTeamRoutes, type TeamRouteDeps } from "./teams.ts";

const ID = "d8OshqLZvtcKDcNluPuyo";
const page = readFileSync(join(import.meta.dirname, "..", "fixtures", "grok-share-page.html"), "utf8");
const realFetch = globalThis.fetch;
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjQxMDI0NDQ4MDB9.c2lnbmF0dXJlLXZhbHVl";
/** A Cursor session over a throwaway folder, talking to a stubbed Cursor. */
function cursor(answer: (url: string) => Response = () => new Response("", { status: 404 })) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-cursor-route-"));
  dirs.push(dataDir);
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url));
    return answer(String(url));
  }) as unknown as typeof fetch;
  return { session: createCursorSession({ dataDir, fetcher }), calls };
}

async function serve(session: CursorSession = cursor().session) {
  // The Grok routes read none of the team dependencies.
  const routes = [createTeamRoutes({ routines: () => null, orgLibrary: () => null, cursor: () => session } as unknown as TeamRouteDeps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
    if (!handled) json(res, 404, { error: "not routed" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, path = "/api/team-library/grok") =>
    realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return Object.assign(post, { get: (path: string) => realFetch(`${base}${path}`) });
}

describe("POST /api/team-library/grok", () => {
  it("is an admin route, like the GitHub import", () => {
    expect(requiredScope("POST", "/api/team-library/grok")).toBe("admin");
    expect(requiredScope("POST", "/api/team-library/github")).toBe("admin");
    for (const [method, route] of [["GET", "/api/team-library/cursor"], ["POST", "/api/team-library/cursor/sign-in"], ["POST", "/api/team-library/cursor/sign-out"]]) {
      expect(requiredScope(method!, route!), route).toBe("admin");
    }
  });

  it("answers the public card for a share link", async () => {
    const upstream = vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", upstream);
    const post = await serve();
    const response = await post({ url: `https://x.ai/bot/${ID}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ shareId: ID, name: "DOGE (Department of Grok Efficiency)", creator: "Avid", url: `https://x.ai/bot/${ID}` });
    expect(upstream).toHaveBeenCalledExactlyOnceWith(`https://x.ai/bot/${ID}`, expect.objectContaining({ redirect: "manual" }));
  });

  it("refuses a missing or foreign link without fetching, and passes on a missing bot", async () => {
    const upstream = vi.fn(async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("fetch", upstream);
    const post = await serve();
    expect((await post({})).status).toBe(400);
    const foreign = await post({ url: `https://evil.example/bot/${ID}` });
    expect(foreign.status).toBe(400);
    expect(((await foreign.json()) as { error: string }).error).toMatch(/Paste a Grok Bot link/);
    expect(upstream).not.toHaveBeenCalled();
    expect((await post({ url: `https://x.ai/bot/${ID}` })).status).toBe(404);
  });

  it("signs in to Cursor, then answers the full setup with the card, never the token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } })));
    const recipe = { profile: { name: "DOGE", description: "Audit every bot. Never change anything without a yes." }, skills: [], routines: [], plugins: [{ pluginId: "slack" }] };
    const stub = cursor((url) => {
      if (url.includes("/auth/poll")) return new Response(JSON.stringify({ accessToken: TOKEN }));
      if (url.endsWith("/GetGrokBotTemplateImportDetails")) return new Response(JSON.stringify({ blobGetUrl: "https://blobs.cursor-cdn.example/r.json" }));
      return new Response(JSON.stringify(recipe));
    });
    const post = await serve(stub.session);
    const started = (await (await post({}, "/api/team-library/cursor/sign-in")).json()) as { url: string };
    expect(new URL(started.url).origin).toBe("https://cursor.com");
    const bodies: string[] = [];
    const status = await post.get("/api/team-library/cursor");
    bodies.push(await status.text());
    expect(JSON.parse(bodies[0]!)).toEqual({ signedIn: true, waiting: false });
    const full = await post({ url: `https://x.ai/bot/${ID}` });
    bodies.push(await full.text());
    expect(full.status).toBe(200);
    expect(JSON.parse(bodies[1]!)).toMatchObject({
      shareId: ID, name: "DOGE (Department of Grok Efficiency)", creator: "Avid",
      export: { format: "openmaus.grok/1", name: "DOGE", instructions: recipe.profile.description, creator: "Avid", sourceUrl: `https://x.ai/bot/${ID}` },
    });
    const out = await post({}, "/api/team-library/cursor/sign-out");
    bodies.push(await out.text());
    expect(JSON.parse(bodies[2]!)).toEqual({ signedIn: false, waiting: false });
    for (const body of bodies) expect(body).not.toContain(TOKEN);
  });

  it("keeps the card and says why when Cursor refuses the full setup", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } })));
    const stub = cursor((url) => (url.includes("/auth/poll") ? new Response(JSON.stringify({ accessToken: TOKEN })) : new Response("{}", { status: 401 })));
    const post = await serve(stub.session);
    await post({}, "/api/team-library/cursor/sign-in");
    await post.get("/api/team-library/cursor");
    const response = await post({ url: `https://x.ai/bot/${ID}` });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ shareId: ID, name: "DOGE (Department of Grok Efficiency)", exportNote: "Cursor refused the sign-in (HTTP 401). Sign in again." });
    expect(body.export).toBeUndefined();
    expect((await (await post.get("/api/team-library/cursor")).json())).toEqual({ signedIn: false, waiting: false });
  });

  it("calls Cursor for nothing while signed out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(page, { headers: { "content-type": "text/html" } })));
    const stub = cursor();
    const post = await serve(stub.session);
    const body = (await (await post({ url: `https://x.ai/bot/${ID}` })).json()) as Record<string, unknown>;
    expect(body.export).toBeUndefined();
    expect(body.exportNote).toBeUndefined();
    expect(stub.calls).toEqual([]);
  });
});

