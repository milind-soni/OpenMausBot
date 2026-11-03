import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createChannelRoutes, type ChannelRouteDeps } from "./channels.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function fixture(refusal: string | null) {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Scout" });
  const room = store.createGroup("Desk", [bot.id]);
  const threadId = room.threadId;
  // SAFETY: a thread PATCH reads only these dependencies; any other would fail the request, and with it the test.
  const deps = { store, routines: () => null, cloudThreadRefusal: () => refusal, groupThreadIsWorking: () => false } as unknown as ChannelRouteDeps;
  const routes = [createChannelRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
    try {
      if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = async (body: unknown) => {
    const response = await fetch(`${base}/api/groups/${room.id}/tasks/${threadId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { patch, archivedAt: () => store.groupTaskByThread(room.id, threadId)?.archivedAt };
}

describe("PATCH /api/groups/:id/tasks/:threadId archivedAt", () => {
  it("archives and unarchives a room thread", async () => {
    const { patch, archivedAt } = await fixture(null);
    expect((await patch({ archivedAt: 7 })).status).toBe(200);
    expect(archivedAt()).toBe(7);
    expect((await patch({ archivedAt: null })).status).toBe(200);
    expect(archivedAt()).toBeUndefined();
  });

  it("leaves a thread the caller may not change as it was, either way", async () => {
    const refusal = "On this Cloud you can only change conversations you started.";
    const { patch, archivedAt } = await fixture(refusal);
    expect(await patch({ archivedAt: 7 })).toEqual({ status: 403, body: { error: refusal } });
    expect(archivedAt()).toBeUndefined();
    expect(await patch({ archivedAt: null })).toEqual({ status: 403, body: { error: refusal } });
  });
});
