import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { createCloudComputerRecoveryRoutes, type CloudComputerRecoveryRouteDeps } from "./cloud-computer-recovery.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const bot = (patch: Partial<BotRecord> = {}) => ({ id: "bot-1", name: "Ada", ...patch }) as BotRecord;

async function serve(deps: Partial<CloudComputerRecoveryRouteDeps> = {}, actions: string[] = []) {
  const claimed: string[] = [];
  const routes = [createCloudComputerRecoveryRoutes({
    store: { bot: (id) => (id === "bot-1" ? bot() : null) },
    boatRecovery: {
      status: () => ({ state: "replaced", at: 1 }),
      restart: async (owner) => { actions.push(`restart ${owner}`); return { answers: true }; },
      replace: async (owner) => { actions.push(`replace ${owner}`); return { replaced: true }; },
      stuck: () => false,
    },
    computerProviderConfigTransitions: new Set(),
    providerTransitionMessage: () => "changing",
    botHasActiveTurn: () => false,
    botComputerControlKey: (record) => record.id,
    claimBotComputerLifecycle: (botId) => { claimed.push(botId); return () => claimed.push(`released ${botId}`); },
    cloudComputerUsed: () => {},
    ...deps,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/bots`, claimed };
}
const post = (url: string, body: unknown, contentType = "application/json") =>
  fetch(url, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });

describe("the computer panel's recovery routes", () => {
  it("are for admins only", () => {
    expect(requiredScope("GET", "/api/bots/bot-1/computer/recovery")).toBe("admin");
    expect(requiredScope("POST", "/api/bots/bot-1/computer/recovery")).toBe("admin");
  });

  it("report what MausBot is doing about the bot's computer", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/bot-1/computer/recovery`);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ recovery: { state: "replaced", at: 1 } });
    expect((await fetch(`${base}/nobody/computer/recovery`)).status).toBe(404);
  });

  it("restart and replace run the shared recovery under the bot's lifecycle lane", async () => {
    const actions: string[] = [];
    const { base, claimed } = await serve({}, actions);
    expect(await (await post(`${base}/bot-1/computer/recovery`, { action: "restart" })).json()).toEqual({ answers: true });
    expect(await (await post(`${base}/bot-1/computer/recovery`, { action: "replace" })).json()).toEqual({ replaced: true });
    expect(actions).toEqual(["restart bot-1", "replace bot-1"]);
    expect(claimed).toEqual(["bot-1", "released bot-1", "bot-1", "released bot-1"]);
  });

  it("refuse a form post, an unknown action, a VPS bot and a team's shared computer", async () => {
    const actions: string[] = [];
    const { base } = await serve({ store: { bot: (id) => (id === "vps" ? bot({ id, cloudBackend: "vps" }) : id === "team" ? bot({ id }) : null) },
      botComputerControlKey: (record) => (record.id === "team" ? "team:computer" : record.id) }, actions);
    expect((await post(`${base}/vps/computer/recovery`, { action: "restart" }, "text/plain")).status).toBe(415);
    expect((await post(`${base}/vps/computer/recovery`, { action: "reboot" })).status).toBe(400);
    expect((await post(`${base}/vps/computer/recovery`, { action: "restart" })).status).toBe(409);
    expect((await post(`${base}/team/computer/recovery`, { action: "replace" })).status).toBe(409);
    expect(actions).toEqual([]);
  });

  it("leave a working computer alone while the bot uses it, but not one that stopped answering", async () => {
    const actions: string[] = [];
    let stuck = false;
    const { base } = await serve({
      botHasActiveTurn: () => true,
      boatRecovery: { status: () => null, stuck: () => stuck,
        restart: async () => ({ answers: true }), replace: async (owner) => { actions.push(owner); return { replaced: true }; } },
    }, actions);
    expect((await post(`${base}/bot-1/computer/recovery`, { action: "replace" })).status).toBe(409);
    stuck = true;
    expect((await post(`${base}/bot-1/computer/recovery`, { action: "replace" })).status).toBe(200);
    expect(actions).toEqual(["bot-1"]);
  });
});
