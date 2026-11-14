import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type { SkillShareRecord } from "../../shared/skill-request.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createSkillShareRoutes } from "./skill-share.ts";
import { dispatchRoutes } from "./table.ts";

const SHARED: SkillShareRecord = { library: "installed", sha256: "a".repeat(64), sharedAt: 1, assigned: [], skipped: [] };

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(enabled = true) {
  const calls: string[] = [];
  const routes = [createSkillShareRoutes({
    enabled: () => enabled,
    botExists: (id) => id === "bot-1",
    cardRefusal: (_auth, threadId) => threadId === "guest-thread" ? "read-only access" : null,
    shareFromReceipt: (threadId, requestId) => {
      calls.push(`receipt ${threadId} ${requestId}`);
      return requestId === "stale" ? { ok: false, status: 409, error: "changed since" } : { ok: true, shared: SHARED };
    },
    shareFromBot: (botId, name) => {
      calls.push(`bot ${botId} ${name}`);
      return SHARED;
    },
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { calls, post };
}

describe("skill share routes", () => {
  it("shares a receipt's skill and passes a stale receipt's conflict through", async () => {
    const { calls, post } = await serve();
    const ok = await post("/api/threads/thread-1/share-skill", { requestId: "req-1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, shared: SHARED });
    const stale = await post("/api/threads/thread-1/share-skill", { requestId: "stale" });
    expect(stale.status).toBe(409);
    expect((await post("/api/threads/thread-1/share-skill", {})).status).toBe(400);
    expect((await post("/api/threads/guest-thread/share-skill", { requestId: "req-1" })).status).toBe(403);
    expect(calls).toEqual(["receipt thread-1 req-1", "receipt thread-1 stale"]);
  });

  it("shares by name for a known bot only", async () => {
    const { calls, post } = await serve();
    expect((await post("/api/bots/bot-1/skills/rough-cut/share")).status).toBe(200);
    expect((await post("/api/bots/nobody/skills/rough-cut/share")).status).toBe(404);
    expect(calls).toEqual(["bot bot-1 rough-cut"]);
  });

  it("answers 404 while sharing is off and leaves other paths to the next handler", async () => {
    const { calls, post } = await serve(false);
    expect((await post("/api/threads/thread-1/share-skill", { requestId: "req-1" })).status).toBe(404);
    expect(await (await post("/api/bots/bot-1/skills")).json()).toEqual({ from: "inline routes" });
    expect(calls).toEqual([]);
  });
});
