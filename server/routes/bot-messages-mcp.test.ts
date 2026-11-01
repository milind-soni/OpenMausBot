import { rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { json, readBody } from "../harness/http.ts";
import { McpRequestService, type McpApplied } from "../host/mcp-requests.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createBotMessageRoutes, type BotMessageRouteDeps } from "./bot-messages.ts";
import { dispatchRoutes } from "./table.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const servers: Server[] = [];

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

it("refuses an MCP card's Turn on from a local browser while a bot is busy, and lets the same answer through once every bot is idle", async () => {
  const store = new Store(() => sonnet);
  const kiwi = store.createBot({ name: "Kiwi" });
  const clive = store.createBot({ name: "Clive" });
  const apply = vi.fn(async (): Promise<McpApplied> => ({ state: "applied", text: "Turned on MCP server linear." }));
  const cards = new McpRequestService({ store, teamCloud: false, apply, answer: () => true, decide: () => {} });
  const { requestId } = cards.propose({ botId: kiwi.id, threadId: kiwi.threadId, action: "enable", name: "linear", targetHash: "0".repeat(64) }, "https://mcp.linear.app/mcp");
  const deps = {
    store, routines: () => null, desktopManaged: false, activeGroupTurnForBot: () => null,
    requestBehavior: (value: unknown) => (value === "allow" || value === "deny" || value === "answer" ? value : null),
    answeredIn: (threadId: string) => threadId,
    cardAnswerRefusal: () => null,
    answeringCardAs: async (_auth: RequestAuth, _threadId: string, _requestId: string, work: () => Promise<unknown>) => { await work(); },
    resolveAndSendTrust: () => false,
    resolveAndSendMcp: async (res: Parameters<BotMessageRouteDeps["resolveAndSendMcp"]>[0], args: Parameters<BotMessageRouteDeps["resolveAndSendMcp"]>[1], ownerReview: boolean) => {
      const outcome = await cards.respond(args, ownerReview);
      if (!outcome) return false;
      json(res, outcome.status, outcome.body);
      return true;
    },
  } as unknown as BotMessageRouteDeps;
  const routes = [createBotMessageRoutes(deps)];
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
  const allow = async () => {
    const response = await fetch(`${base}/api/threads/${kiwi.threadId}/respond`, {
      method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ requestId, behavior: "allow" }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  store.setTaskActivity(clive.id, clive.threadId, "working");
  expect(store.bot(clive.id)?.busy).toBe(true);
  const refused = await allow();
  expect(refused.status).toBe(403);
  expect(String(refused.body.error)).toContain("wait until every bot is idle");
  expect(apply).not.toHaveBeenCalled();

  store.setTaskActivity(clive.id, clive.threadId, "idle");
  expect(await allow()).toMatchObject({ status: 200, body: { ok: true, result: { state: "applied" } } });
  expect(apply).toHaveBeenCalledOnce();
});
