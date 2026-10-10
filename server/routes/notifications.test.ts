// The notification routes are exercised through the route table on a real HTTP
// server, with a stand-in for index.ts's inline routes behind it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
import { createNotificationRoutes } from "./notifications.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const sample: NotificationLogEntry = { id: "n1", at: 1, kind: "done", botId: "b1", botName: "Scout", threadId: "t1", title: "done", body: "", read: false };

async function serve() {
  const deps = { recent: vi.fn(() => [sample]), markRead: vi.fn(), markAllRead: vi.fn() };
  const routes = [createNotificationRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { deps, base };
}

describe("notification routes", () => {
  it("lists the feed", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/api/notifications`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notifications: [sample] });
  });

  it("marks one entry read, and all entries read", async () => {
    const { base, deps } = await serve();
    expect((await fetch(`${base}/api/notifications/n1/read`, { method: "POST" })).status).toBe(200);
    expect(deps.markRead).toHaveBeenCalledWith("n1");
    expect((await fetch(`${base}/api/notifications/read-all`, { method: "POST" })).status).toBe(200);
    expect(deps.markAllRead).toHaveBeenCalledTimes(1);
    expect(deps.markRead).toHaveBeenCalledTimes(1);
  });

  it("leaves other paths and methods to the next handler", async () => {
    const { base, deps } = await serve();
    expect((await fetch(`${base}/api/notifications`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/notifications/n1/read`)).status).toBe(404);
    expect((await fetch(`${base}/api/notifications/n1/other`, { method: "POST" })).status).toBe(404);
    expect(deps.markRead).not.toHaveBeenCalled();
  });
});
