// The Slack management link is served by a route module, so it is exercised
// the way a request reaches it: through the table, on a real HTTP server,
// with a stand-in for index.ts's inline routes behind it.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { createHostedSlackRoutes, type HostedSlackRouteDeps } from "./hosted-slack.ts";
import { dispatchRoutes } from "./table.ts";

const HOSTED = {
  OMB_ADMIN_URL: "https://admin.example.test",
  OMB_PUBLIC_URL: "https://acme.example.test",
  OMB_ADMIN_WORKSPACE: "acme",
  OMB_ADMIN_MEMBERSHIP: "portal",
};
const BOTS: Record<string, { id: string; hidden?: boolean }> = {
  bot_123: { id: "bot_123" },
  "bot-hidden": { id: "bot-hidden", hidden: true },
};

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(deps: Partial<HostedSlackRouteDeps>): Promise<string> {
  const routes = [createHostedSlackRoutes({ bot: (id) => BOTS[id], hostedReady: () => true, env: HOSTED, ...deps })];
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
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/bots/:id/slack-management through the route table", () => {
  it("answers a hosted workspace with the Admin link for that bot, uncached", async () => {
    const base = await serve({});
    const response = await fetch(`${base}/api/bots/bot_123/slack-management`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      available: true,
      managementUrl: "https://admin.example.test/slack?workspace=acme&bot=bot_123",
    });
  });

  it("answers { available: false }, not an error, on a local install", async () => {
    const local = await serve({ env: {}, hostedReady: () => false });
    const response = await fetch(`${local}/api/bots/bot_123/slack-management`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false });
    // Hosted configuration alone is not enough: the workspace hook must be live.
    const notReady = await serve({ hostedReady: () => false });
    expect(await (await fetch(`${notReady}/api/bots/bot_123/slack-management`)).json()).toEqual({ available: false });
    // Nor is a live hook enough without portal membership.
    const localMembership = await serve({ env: { ...HOSTED, OMB_ADMIN_MEMBERSHIP: "local" } });
    expect(await (await fetch(`${localMembership}/api/bots/bot_123/slack-management`)).json()).toEqual({ available: false });
  });

  it("builds the link from configuration, ignoring everything else in the request", async () => {
    const base = await serve({});
    const response = await fetch(`${base}/api/bots/bot_123/slack-management?workspace=other&bot=other&admin=https://evil.example.test`, {
      headers: { "x-forwarded-host": "evil.example.test", origin: "https://evil.example.test" },
    });
    expect((await response.json() as { managementUrl?: string }).managementUrl).toBe("https://admin.example.test/slack?workspace=acme&bot=bot_123");
  });

  it("refuses a missing or hidden bot", async () => {
    const base = await serve({});
    for (const id of ["missing", "bot-hidden"]) {
      const response = await fetch(`${base}/api/bots/${id}/slack-management`);
      expect(response.status, id).toBe(404);
      expect(await response.json()).toEqual({ error: "no such bot" });
    }
  });

  it("passes on every other method and path, including ids outside the bot id alphabet", async () => {
    const base = await serve({});
    for (const [method, path] of [
      ["POST", "/api/bots/bot_123/slack-management"], ["DELETE", "/api/bots/bot_123/slack-management"],
      ["GET", "/api/bots/bot_123/slack-management/extra"], ["GET", "/api/bots/bot_123"],
      ["GET", "/api/bots/bot%26workspace%3Dother/slack-management"], ["GET", "/api/bots//slack-management"],
    ] as const) {
      const response = await fetch(`${base}${path}`, { method });
      expect(await response.json(), `${method} ${path}`).toEqual({ from: "inline routes" });
    }
  });
});
