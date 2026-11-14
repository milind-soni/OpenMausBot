import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { WebhookManager } from "../webhooks.ts";
import { dispatchRoutes } from "./table.ts";
import { createWebhookRoutes } from "./webhooks.ts";

const servers: Server[] = [];
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), "omb-webhook-routes-"));
  folders.push(made);
  return made;
}
const manager = (file: string) => new WebhookManager({ file, botState: () => "ready", enqueue: () => ({ id: "run-1" }), roomMember: () => ({ ok: true }),
  roomPost: async (trigger) => ({ posted: true, attachments: 0, threadId: `${trigger.groupId}-thread` }) });

async function serve(seen: (botId: string) => boolean = () => true, file = join(folder(), "webhooks.json"), seesRoom: (groupId: string) => boolean = () => true) {
  const webhooks = manager(file);
  const routes = [createWebhookRoutes({ webhooks, ingress: () => ({ available: true, baseUrl: "http://127.0.0.1:8800" }), visible: () => ({ everything: false, bot: seen, group: seesRoom }) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  return { webhooks, file, call };
}

describe("a webhook's address for the person", () => {
  it("is an admin route that reads the kept address without replacing it, so a setup the bot made keeps working", async () => {
    expect(requiredScope("GET", "/api/webhooks/hook-1/address")).toBe("admin");
    const { webhooks, call } = await serve();
    const created = webhooks.create({ name: "Watcher", prompt: "Summarize it", botId: "bot-a" });
    const read = await call("GET", `/api/webhooks/${created.webhook.id}/address`);
    expect(read).toMatchObject({ status: 200, body: { credential: { url: `http://127.0.0.1:8800/hooks/${created.webhook.endpointId}/${created.secret}`, secret: created.secret } } });
    expect(read.body.webhook).not.toHaveProperty("sealedSecret");
    expect(webhooks.authorize(created.webhook.endpointId, created.secret)).toBe(true);
    // Replace address is the only way to a new one.
    const rotated = await call("POST", `/api/webhooks/${created.webhook.id}/rotate`);
    expect((await call("GET", `/api/webhooks/${created.webhook.id}/address`)).body.credential.secret).toBe(rotated.body.credential.secret);
    expect(webhooks.authorize(created.webhook.endpointId, created.secret)).toBe(false);
  });

  it("answers as for a missing id when the viewer cannot see the bot, and never mints one from before addresses were kept", async () => {
    const hidden = await serve((botId) => botId !== "bot-hidden");
    const theirs = hidden.webhooks.create({ name: "Hidden", prompt: "", botId: "bot-hidden" });
    expect(await hidden.call("GET", `/api/webhooks/${theirs.webhook.id}/address`)).toEqual({ status: 404, body: { error: "no such webhook" } });
    expect((await hidden.call("GET", "/api/webhooks")).body.webhooks).toEqual([]);

    const file = join(folder(), "webhooks.json");
    const old = manager(file).create({ name: "Old", prompt: "", botId: "bot-a" });
    const disk = JSON.parse(readFileSync(file, "utf8"));
    delete disk.webhooks[0].sealedSecret;
    writeFileSync(file, JSON.stringify(disk));
    const legacy = await serve(() => true, file);
    expect(await legacy.call("GET", `/api/webhooks/${old.webhook.id}/address`)).toEqual({ status: 404, body: { error: "this address was made before addresses were kept", kept: false } });
    // The address a person copied before still works: reading never replaced it.
    expect(legacy.webhooks.authorize(old.webhook.endpointId, old.secret)).toBe(true);
    expect(legacy.webhooks.currentSecret(old.webhook.id, false)?.secret).toBeNull();
  });

  it("shows a room webhook, and what it posted, only to someone who sees the room as well as the bot", async () => {
    const member = await serve(() => true, undefined, (groupId) => groupId !== "room-private");
    member.webhooks.create({ name: "Open room", prompt: "", botId: "bot-a", delivery: "post", groupId: "room-open" });
    const closed = member.webhooks.create({ name: "Closed room", prompt: "", botId: "bot-a", delivery: "post", groupId: "room-private" });
    await member.webhooks.receive(closed.webhook.endpointId, closed.secret, { payload: { text: "The salary review moved to Friday" } });
    const listed = (await member.call("GET", "/api/webhooks")).body;
    expect(listed.webhooks.map((hook: { name: string }) => hook.name)).toEqual(["Open room"]);
    expect(listed.attempts).toEqual([]);
    expect(await member.call("GET", `/api/webhooks/${closed.webhook.id}/address`)).toEqual({ status: 404, body: { error: "no such webhook" } });
  });
});
