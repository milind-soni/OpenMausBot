// "Free up space" over HTTP: who may use it, and what it answers.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { HOSTED_PROVIDER_SETTINGS_ERROR } from "../hosted-models.ts";
import { requiredScope } from "../request-auth.ts";
import { BUSY_LEFTOVER_ERROR, createAntigravityLeftoverRoutes, type AntigravityLeftoverRouteDeps } from "./antigravity-leftovers.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const SECRET_PATH = "C:\\Users\\ada\\AppData\\Local\\Temp\\_MEI000022222";

async function serve(deps: Partial<AntigravityLeftoverRouteDeps> = {}): Promise<string> {
  const routes = [createAntigravityLeftoverRoutes({
    hosted: false,
    isAntigravity: (id) => id === "antigravity",
    find: async () => ({ folders: [{ path: SECRET_PATH, where: "system", bytes: 2_000 }], bytes: 2_000, complete: true }),
    remove: async () => ({ removed: 1, freedBytes: 2_000, remaining: 0 }),
    ...deps,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (url: string, contentType = "application/json") =>
  fetch(url, { method: "POST", headers: { "content-type": contentType }, body: "{}" });

describe("Free up space routes", () => {
  it("are for admins only", () => {
    expect(requiredScope("GET", "/api/instances/antigravity/leftover-files")).toBe("admin");
    expect(requiredScope("POST", "/api/instances/antigravity/leftover-files/remove")).toBe("admin");
  });

  it("says how much was found without naming any path", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/instances/antigravity/leftover-files`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ bytes: 2_000, folders: 1, complete: true });
    expect(text).not.toContain("_MEI");
    expect(text).not.toContain("ada");
  });

  it("deletes only on a JSON POST", async () => {
    let removals = 0;
    const base = await serve({ remove: async () => { removals++; return { removed: 1, freedBytes: 2_000, remaining: 0 }; } });
    expect((await post(`${base}/api/instances/antigravity/leftover-files/remove`, "text/plain")).status).toBe(415);
    // A GET to the delete path is not this route's.
    expect(await (await fetch(`${base}/api/instances/antigravity/leftover-files/remove`)).json()).toEqual({ from: "inline routes" });
    expect(removals).toBe(0);
    const response = await post(`${base}/api/instances/antigravity/leftover-files/remove`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ freedBytes: 2_000, removed: 1, remaining: 0 });
    expect(removals).toBe(1);
  });

  it("is refused on a hosted team workspace", async () => {
    let touched = false;
    const base = await serve({
      hosted: true,
      find: async () => { touched = true; return { folders: [], bytes: 0, complete: true }; },
      remove: async () => { touched = true; return { removed: 0, freedBytes: 0, remaining: 0 }; },
    });
    for (const response of [
      await fetch(`${base}/api/instances/antigravity/leftover-files`),
      await post(`${base}/api/instances/antigravity/leftover-files/remove`),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: HOSTED_PROVIDER_SETTINGS_ERROR });
    }
    expect(touched).toBe(false);
  });

  it("is only offered by Antigravity", async () => {
    const base = await serve();
    expect((await fetch(`${base}/api/instances/codex/leftover-files`)).status).toBe(404);
    expect((await post(`${base}/api/instances/codex/leftover-files/remove`)).status).toBe(404);
  });

  it("runs one scan or delete at a time", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const base = await serve({ find: async () => { await held; return { folders: [], bytes: 0, complete: true }; } });
    const first = fetch(`${base}/api/instances/antigravity/leftover-files`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await post(`${base}/api/instances/antigravity/leftover-files/remove`);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: BUSY_LEFTOVER_ERROR });
    release();
    expect((await first).status).toBe(200);
    expect((await post(`${base}/api/instances/antigravity/leftover-files/remove`)).status).toBe(200);
  });
});
