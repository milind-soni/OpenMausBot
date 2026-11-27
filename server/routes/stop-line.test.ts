import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createStopLineRoutes } from "./stop-line.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function ask(body: unknown): Promise<{ status: number; body: any }> {
  const routes = [createStopLineRoutes()];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
    if (!handled) json(res, 404, { error: "not here" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stop-line`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

describe("POST /api/stop-line", () => {
  it("says a line of stop words is a stop, by the rule each bot's own send path uses", async () => {
    expect((await ask({ text: "stop" })).body).toEqual({ stop: true });
    expect((await ask({ text: "stop everything now" })).body).toEqual({ stop: true });
  });

  it("says a line that asks for anything else is not one", async () => {
    expect((await ask({ text: "stop the export and send me the summary" })).body).toEqual({ stop: false });
    expect((await ask({ text: "we need to fetch mail" })).body).toEqual({ stop: false });
    expect((await ask({ text: `stop ${"now ".repeat(600)}` })).body).toEqual({ stop: false });
  });

  it("refuses a body without text, and is open to a paired device like a send", async () => {
    expect((await ask({})).status).toBe(400);
    expect(requiredScope("POST", "/api/stop-line")).toBe("client");
    expect(requiredScope("GET", "/api/stop-line")).toBe("admin");
  });
});
