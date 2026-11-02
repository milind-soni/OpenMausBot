import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { createSavedStepsRoutes } from "./saved-steps.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function fixture() {
  const forgets: Array<[string, string]> = [];
  const held = new Set(["b1/r1"]);
  const routes = [createSavedStepsRoutes({
    bot: (id) => (id === "b1" ? { id } : undefined),
    forget: (botId, recipeId) => { forgets.push([botId, recipeId]); return held.delete(`${botId}/${recipeId}`); },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) {
      json(res, 404, { from: "no route" });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = "DELETE"): Promise<[number, unknown]> => {
    const response = await fetch(base + path, { method });
    return [response.status, await response.json()];
  };
  return { forgets, call, del: (path: string) => call(path) };
}

describe("DELETE /api/bots/:botId/saved-steps/:recipeId", () => {
  it("forgets a saved recipe", async () => {
    const { del, forgets } = await fixture();
    expect(await del("/api/bots/b1/saved-steps/r1")).toEqual([200, { forgotten: true }]);
    expect(forgets).toEqual([["b1", "r1"]]);
  });

  it("is idempotent for a recipe that is gone", async () => {
    const { del } = await fixture();
    expect(await del("/api/bots/b1/saved-steps/r9")).toEqual([200, { forgotten: false }]);
    expect(await del("/api/bots/b1/saved-steps/r1")).toEqual([200, { forgotten: true }]);
    expect(await del("/api/bots/b1/saved-steps/r1")).toEqual([200, { forgotten: false }]);
  });

  it("answers 404 for an unknown bot", async () => {
    const { del, forgets } = await fixture();
    expect((await del("/api/bots/zz/saved-steps/r1"))[0]).toBe(404);
    expect(forgets).toEqual([]);
  });

  it("answers 400 for a recipe id that is not an id", async () => {
    const { del, forgets } = await fixture();
    expect((await del("/api/bots/b1/saved-steps/a.b"))[0]).toBe(400);
    expect((await del(`/api/bots/b1/saved-steps/${"x".repeat(65)}`))[0]).toBe(400);
    expect(forgets).toEqual([]);
  });

  it("is an owner and admin action, never a client's", () => {
    expect(requiredScope("DELETE", "/api/bots/b1/saved-steps/r1")).toBe("admin");
    expect(requiredScope("DELETE", "/api/bots/b1/saved-steps/r1", { sharedComputers: true })).toBe("admin");
  });

  it("passes other methods and paths", async () => {
    const { call, forgets } = await fixture();
    expect(await call("/api/bots/b1/saved-steps/r1", "GET")).toEqual([404, { from: "no route" }]);
    expect(await call("/api/bots/b1/saved-steps", "DELETE")).toEqual([404, { from: "no route" }]);
    expect(forgets).toEqual([]);
  });
});
