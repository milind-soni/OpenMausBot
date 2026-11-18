import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { StarterAwake } from "../host/starter-awake.ts";
import { requiredScope } from "../request-auth.ts";
import { createStarterAwakeRoutes, STARTER_AWAKE_PATH } from "./starter-awake.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(awake: StarterAwake): Promise<string> {
  const routes = [createStarterAwakeRoutes({ awake })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${STARTER_AWAKE_PATH}`;
}

function fakeAwake() {
  const chosen: string[][] = [];
  const awake: StarterAwake = {
    limit: () => 5, paused: () => ["b5"], isPaused: () => false,
    choose: (ids) => { if (ids.length !== 5) return { ok: false, error: "choose 5 bots to keep awake" }; chosen.push([...ids]); return { ok: true }; },
  };
  return { awake, chosen };
}

const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("choosing a Starter Cloud's awake bots", () => {
  it("is an admin's", () => {
    expect(requiredScope("POST", STARTER_AWAKE_PATH)).toBe("admin");
  });

  it("keeps the chosen bots awake and answers with who is paused now", async () => {
    const { awake, chosen } = fakeAwake();
    const response = await post(await serve(awake), { awake: ["b0", "b1", "b2", "b3", "b4"] });
    expect([response.status, await response.json(), chosen]).toEqual([200, { paused: ["b5"] }, [["b0", "b1", "b2", "b3", "b4"]]]);
  });

  it("refuses anything but a list of ids, and a choice the plan refuses", async () => {
    const { awake, chosen } = fakeAwake();
    const url = await serve(awake);
    expect((await post(url, { awake: "b0" })).status).toBe(400);
    expect((await post(url, { awake: [1, 2] })).status).toBe(400);
    const refused = await post(url, { awake: ["b0"] });
    expect([refused.status, await refused.json()]).toEqual([400, { error: "choose 5 bots to keep awake" }]);
    expect((await fetch(url)).status).toBe(405);
    expect(chosen).toEqual([]);
  });
});
