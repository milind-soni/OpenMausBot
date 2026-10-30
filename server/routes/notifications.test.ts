import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { NotificationLogEntry } from "../../shared/notification.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createNotificationRoutes } from "./notifications.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const sample: NotificationLogEntry = { id: "n1", at: 1, kind: "done", botId: "b1", botName: "Scout", threadId: "t1", title: "done", body: "", read: false };

async function serve(
  entries: NotificationLogEntry[] = [sample],
  shown?: (auth: RequestAuth) => (threadId: string) => boolean,
  reaches?: (auth: RequestAuth, entry: NotificationLogEntry) => boolean,
) {
  const deps = { recent: vi.fn(() => entries), markRead: vi.fn() };
  const routes = [createNotificationRoutes(deps, shown, reaches)];
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
    expect(deps.markRead).toHaveBeenLastCalledWith(["n1"]);
    expect((await fetch(`${base}/api/notifications/read-all`, { method: "POST" })).status).toBe(200);
    expect(deps.markRead).toHaveBeenLastCalledWith(["n1"]);
    expect(deps.markRead).toHaveBeenCalledTimes(2);
  });

  it("marks read only what the viewer's own list shows", async () => {
    const hiddenThread = { ...sample, id: "n2", threadId: "private" };
    const elsewhere = { ...sample, id: "n3", threadId: "t2" };
    const alreadyRead = { ...sample, id: "n4", read: true };
    const { base, deps } = await serve([sample, hiddenThread, elsewhere, alreadyRead],
      () => (threadId) => threadId !== "private", (_auth, entry) => entry.id !== "n3");
    const listed = await (await fetch(`${base}/api/notifications`)).json() as { notifications: NotificationLogEntry[] };
    expect(listed.notifications.map((entry) => entry.id)).toEqual(["n1", "n4"]);

    expect((await fetch(`${base}/api/notifications/read-all`, { method: "POST" })).status).toBe(200);
    expect(deps.markRead).toHaveBeenCalledExactlyOnceWith(["n1"]);
    for (const id of ["n2", "n3", "missing"]) {
      expect((await fetch(`${base}/api/notifications/${id}/read`, { method: "POST" })).status, id).toBe(404);
    }
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
