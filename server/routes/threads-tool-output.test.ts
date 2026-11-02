import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { dispatchRoutes } from "./table.ts";
import { createThreadRoutes, type ThreadRouteDeps } from "./threads.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(store: Store): Promise<string> {
  const deps = { store, viewerFor: () => ({}), visibleTo: () => ({ bot: () => true, group: () => true }), workspaceAccess: () => null,
    desktopMutationToken: () => undefined, companionMutationToken: () => undefined, cliOwnerToken: () => undefined } as unknown as ThreadRouteDeps;
  const routes = [createThreadRoutes(deps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as RequestAuth;
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/threads/:threadId/messages/:messageId/tool", () => {
  it("returns a tool step's whole output, and 404s anything else", async () => {
    const store = new Store(() => sonnet);
    const bot = store.createBot({ name: "Scout" }, { seedMessages: false });
    const output = "line of output\n".repeat(500);
    const tool = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Bash", ok: true, input: "{}", output } });
    const silent = store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: "Bash", ok: true } });
    const text = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const base = await serve(store);
    const get = async (path: string) => { const res = await fetch(`${base}${path}`); return { status: res.status, body: await res.json() }; };

    expect(await get(`/api/threads/${bot.threadId}/messages/${tool.id}/tool`)).toEqual({ status: 200, body: { output } });
    expect((await get(`/api/threads/${bot.threadId}/messages/${silent.id}/tool`)).status).toBe(404);
    expect((await get(`/api/threads/${bot.threadId}/messages/${text.id}/tool`)).status).toBe(404);
    expect((await get(`/api/threads/${bot.threadId}/messages/no-such-message/tool`)).status).toBe(404);
    expect((await get(`/api/threads/no-such-thread/messages/${tool.id}/tool`)).status).toBe(404);
  });
});
