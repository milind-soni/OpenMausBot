// The route table is how new routes reach a request without an `if` in
// server/index.ts, so its three promises are pinned against a real HTTP
// server: PASS hands on, an answer stops the chain, and a handler that
// answered but returned PASS by mistake cannot let a second handler run.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { PASS, dispatchRoutes, type RouteHandler } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** Serves `routes` the way handleRequest does: the table first, then the
 * caller's stand-in for index.ts's inline routes. */
async function serve(routes: RouteHandler[]): Promise<{ base: string; outcomes: boolean[] }> {
  const outcomes: boolean[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
      });
      outcomes.push(handled);
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, outcomes };
}

describe("route table dispatch", () => {
  it("falls through to the next handler on PASS, in table order", async () => {
    const seen: string[] = [];
    const { base, outcomes } = await serve([
      async () => { seen.push("first"); return PASS; },
      async ({ res, path, json: reply }) => { seen.push("second"); reply(res, 200, { from: "second", path }); },
    ]);
    const response = await fetch(`${base}/api/example`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ from: "second", path: "/api/example" });
    expect(seen).toEqual(["first", "second"]);
    expect(outcomes).toEqual([true]);
  });

  it("stops at the first handler that answers", async () => {
    const seen: string[] = [];
    const { base, outcomes } = await serve([
      async ({ req, res, json: reply, readBody: body }) => { seen.push("first"); reply(res, 201, { echo: await body(req) }); },
      async ({ res, json: reply }) => { seen.push("second"); reply(res, 200, { from: "second" }); },
    ]);
    const response = await fetch(`${base}/api/example`, { method: "POST", body: JSON.stringify({ n: 1 }) });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ echo: { n: 1 } });
    expect(seen).toEqual(["first"]);
    expect(outcomes).toEqual([true]);
  });

  it("hands the request to the inline routes when every handler passes, or none is registered", async () => {
    const passing = await serve([async () => PASS, async () => PASS]);
    expect(await (await fetch(`${passing.base}/api/example`)).json()).toEqual({ from: "inline routes" });
    expect(passing.outcomes).toEqual([false]);
    const empty = await serve([]);
    expect((await fetch(`${empty.base}/api/example`)).status).toBe(404);
    expect(empty.outcomes).toEqual([false]);
  });

  it("treats a handler that answered but returned PASS as the end of the chain", async () => {
    const seen: string[] = [];
    const { base, outcomes } = await serve([
      async ({ res, json: reply }) => { seen.push("first"); reply(res, 200, { from: "first" }); return PASS; },
      // Without the guard this would write a second response and throw.
      async ({ res, json: reply }) => { seen.push("second"); reply(res, 200, { from: "second" }); },
    ]);
    const response = await fetch(`${base}/api/example`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ from: "first" });
    expect(seen).toEqual(["first"]);
    expect(outcomes).toEqual([true]);
  });

  it("lets a handler's error reach the caller's catch", async () => {
    const { base } = await serve([async () => { throw Object.assign(new Error("nope"), { status: 409 }); }]);
    const response = await fetch(`${base}/api/example`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "nope" });
  });
});
