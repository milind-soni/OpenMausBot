import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, serviceAllowed } from "../request-auth.ts";
import { createSeatsRoutes, seatCount } from "./seats.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

describe("seat count", () => {
  it("counts people once each: listed addresses and signed-in addresses, never devices or API tokens", () => {
    const list = { admins: ["ada@example.test"], members: ["grace@example.test", "@example.test"] };
    expect(seatCount(list, [])).toBe(2);
    expect(seatCount(list, [{ email: "Ada@Example.test" }, { email: "ada@example.test" }, {}])).toBe(2);
    expect(seatCount(list, [{ email: "linus@example.test" }])).toBe(3);
    expect(seatCount(list, [{ email: "bot@example.test", token: true }])).toBe(2);
  });

  // Found on a real server: the owner paired by code and one member on the list counted 1.
  it("counts the owner paired by code besides the people with an address, unless the owner has one too", () => {
    const owner = { scopes: ["admin", "client"] };
    expect(seatCount({ admins: [], members: ["grace@example.test"] }, [owner, { email: "grace@example.test", scopes: ["client"] }])).toBe(2);
    expect(seatCount({ admins: ["ada@example.test"], members: ["grace@example.test"] }, [owner])).toBe(2);
    expect(seatCount({ admins: [], members: ["grace@example.test"] }, [owner, { email: "ada@example.test", scopes: ["admin", "client"] }])).toBe(2);
  });

  it("counts a server with paired devices and no address as one person, and an empty one as none", () => {
    expect(seatCount({ admins: [], members: [] }, [{}, {}, {}])).toBe(1);
    expect(seatCount({ admins: [], members: [] }, [])).toBe(0);
    expect(seatCount({ admins: [], members: ["@example.test"] }, [])).toBe(0);
  });

  it("answers with the number alone, to an admin and to the server's own loopback, never to a chat-only session", async () => {
    const routes = [createSeatsRoutes({
      signInList: () => ({ admins: ["ada@example.test"], members: [] }),
      sessions: () => [{ email: "grace@example.test" }],
    })];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
      if (!handled) json(res, 404, {});
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/seats`);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ seats: 2 });
    expect(text).not.toContain("@");
    expect((await fetch(`${base}/api/seats`, { method: "POST" })).status).toBe(404);
    expect(requiredScope("GET", "/api/seats")).toBe("admin");
    expect(serviceAllowed("GET", "/api/seats")).toBe(true);
    expect(serviceAllowed("POST", "/api/seats")).toBe(false);
  });
});
