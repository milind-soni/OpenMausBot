import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { SYSTEM_ACTOR, WebhookManager, type WebhookActor } from "../webhooks.ts";
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
const manager = (file: string) => new WebhookManager({ file, botState: (id) => id === "bot-missing" ? "missing" : "ready", enqueue: () => ({ id: "run-1" }), roomMember: () => ({ ok: true }),
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
    const created = webhooks.create(SYSTEM_ACTOR, { name: "Watcher", prompt: "Summarize it", botId: "bot-a" });
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
    const theirs = hidden.webhooks.create(SYSTEM_ACTOR, { name: "Hidden", prompt: "", botId: "bot-hidden" });
    expect(await hidden.call("GET", `/api/webhooks/${theirs.webhook.id}/address`)).toEqual({ status: 404, body: { error: "no such webhook" } });
    expect((await hidden.call("GET", "/api/webhooks")).body.webhooks).toEqual([]);

    const file = join(folder(), "webhooks.json");
    const old = manager(file).create(SYSTEM_ACTOR, { name: "Old", prompt: "", botId: "bot-a" });
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
    member.webhooks.create(SYSTEM_ACTOR, { name: "Open room", prompt: "", botId: "bot-a", delivery: "post", groupId: "room-open" });
    const closed = member.webhooks.create(SYSTEM_ACTOR, { name: "Closed room", prompt: "", botId: "bot-a", delivery: "post", groupId: "room-private" });
    await member.webhooks.receive(closed.webhook.endpointId, closed.secret, { payload: { text: "The salary review moved to Friday" } });
    const listed = (await member.call("GET", "/api/webhooks")).body;
    expect(listed.webhooks.map((hook: { name: string }) => hook.name)).toEqual(["Open room"]);
    expect(listed.attempts).toEqual([]);
    expect(await member.call("GET", `/api/webhooks/${closed.webhook.id}/address`)).toEqual({ status: 404, body: { error: "no such webhook" } });
  });

  it("refuses mutating or testing a webhook for a bot the viewer cannot see or manage", async () => {
    const hidden = await serve((botId) => botId !== "bot-hidden");
    const theirs = hidden.webhooks.create(SYSTEM_ACTOR, { name: "Hidden", prompt: "", botId: "bot-hidden" });
    const nonexistentId = "00000000-0000-0000-0000-000000000000";

    // Test hidden webhook vs nonexistent id: byte-identical responses
    const testHidden = await hidden.call("POST", `/api/webhooks/${theirs.webhook.id}/test`, {});
    const testNonexistent = await hidden.call("POST", `/api/webhooks/${nonexistentId}/test`, {});
    expect(testHidden).toEqual(testNonexistent);
    expect(testHidden).toEqual({ status: 404, body: { error: "no such webhook" } });

    // Rotate hidden webhook vs nonexistent id
    const rotateHidden = await hidden.call("POST", `/api/webhooks/${theirs.webhook.id}/rotate`);
    const rotateNonexistent = await hidden.call("POST", `/api/webhooks/${nonexistentId}/rotate`);
    expect(rotateHidden).toEqual(rotateNonexistent);
    expect(rotateHidden).toEqual({ status: 404, body: { error: "no such webhook" } });

    // Update hidden webhook vs nonexistent id
    const updateHidden = await hidden.call("PATCH", `/api/webhooks/${theirs.webhook.id}`, { name: "Hacked" });
    const updateNonexistent = await hidden.call("PATCH", `/api/webhooks/${nonexistentId}`, { name: "Hacked" });
    expect(updateHidden).toEqual(updateNonexistent);
    expect(updateHidden).toEqual({ status: 404, body: { error: "no such webhook" } });

    // Delete hidden webhook vs nonexistent id
    const deleteHidden = await hidden.call("DELETE", `/api/webhooks/${theirs.webhook.id}`);
    const deleteNonexistent = await hidden.call("DELETE", `/api/webhooks/${nonexistentId}`);
    expect(deleteHidden).toEqual(deleteNonexistent);
    expect(deleteHidden).toEqual({ status: 404, body: { error: "no such webhook" } });

    // Create webhook for hidden bot vs nonexistent bot
    const createHidden = await hidden.call("POST", "/api/webhooks", { name: "Malicious", prompt: "", botId: "bot-hidden" });
    expect(createHidden.status).toBe(404);
    const createNonexistent = await hidden.call("POST", "/api/webhooks", { name: "Missing", prompt: "", botId: "bot-missing" });
    expect(createNonexistent.status).toBe(400);

    // Extra fields are ignored and cannot mass-assign id or secret
    const createExtra = await hidden.call("POST", "/api/webhooks", { name: "Safe", prompt: "", botId: "bot-a", id: "injected-id", secret: "injected-secret" });
    expect(createExtra.status).toBe(201);
    expect(createExtra.body.webhook.id).not.toBe("injected-id");
    expect(createExtra.body.credential.secret).not.toBe("injected-secret");
  });

  it("permits mutations on visible and manageable webhooks, but returns 403 when visible but not manageable", async () => {
    // Setup a harness where bot-view is visible but level is "view" (not "edit")
    const file = join(folder(), "webhooks.json");
    const webhooks = manager(file);
    const routes = [createWebhookRoutes({
      webhooks,
      ingress: () => ({ available: true, baseUrl: "http://127.0.0.1:8800" }),
      visible: () => ({
        everything: false,
        member: true,
        bot: (id) => id === "bot-view" || id === "bot-manage",
        group: () => true,
        level: (id) => id === "bot-manage" ? "edit" : "view",
      }),
    })];
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

    const viewHook = webhooks.create(SYSTEM_ACTOR, { name: "View Only", prompt: "", botId: "bot-view" });
    const manageHook = webhooks.create(SYSTEM_ACTOR, { name: "Manageable", prompt: "", botId: "bot-manage" });

    // View-only webhook mutations return 403
    expect((await call("POST", `/api/webhooks/${viewHook.webhook.id}/test`, {})).status).toBe(403);
    expect((await call("POST", `/api/webhooks/${viewHook.webhook.id}/rotate`)).status).toBe(403);
    expect((await call("PATCH", `/api/webhooks/${viewHook.webhook.id}`, { name: "Renamed" })).status).toBe(403);
    expect((await call("DELETE", `/api/webhooks/${viewHook.webhook.id}`)).status).toBe(403);
    expect((await call("POST", "/api/webhooks", { name: "New", prompt: "", botId: "bot-view" })).status).toBe(403);

    // Manageable webhook mutations succeed
    expect((await call("POST", `/api/webhooks/${manageHook.webhook.id}/test`, {})).status).toBe(202);
    expect((await call("POST", `/api/webhooks/${manageHook.webhook.id}/rotate`)).status).toBe(200);
    expect((await call("PATCH", `/api/webhooks/${manageHook.webhook.id}`, { name: "Renamed" })).status).toBe(200);
    expect((await call("DELETE", `/api/webhooks/${manageHook.webhook.id}`)).status).toBe(200);
    const created = await call("POST", "/api/webhooks", { name: "New", prompt: "", botId: "bot-manage" });
    expect(created.status).toBe(201);
  });

  it("enforces defense in depth in WebhookManager when called directly with unprivileged actor", () => {
    const file = join(folder(), "webhooks.json");
    const m = manager(file);
    const created = m.create(SYSTEM_ACTOR, { name: "Test", prompt: "", botId: "bot-1" });

    const deniedActor: WebhookActor = {
      canSee: () => true,
      canManage: () => false,
    };
    const blindActor: WebhookActor = {
      canSee: () => false,
      canManage: () => false,
    };

    // Manager directly denies unmanageable actor
    expect(() => m.create(deniedActor, { name: "New", prompt: "", botId: "bot-1" })).toThrow(/cannot manage webhooks for this bot/);
    expect(() => m.test(deniedActor, created.webhook.id)).toThrow(/cannot manage this webhook/);
    expect(() => m.rotateSecret(deniedActor, created.webhook.id)).toThrow(/cannot manage this webhook/);
    expect(() => m.update(deniedActor, created.webhook.id, { name: "Updated" })).toThrow(/cannot manage this webhook/);
    expect(() => m.remove(deniedActor, created.webhook.id)).toThrow(/cannot manage this webhook/);

    // Manager returns null/false/404 for invisible webhook
    expect(() => m.create(blindActor, { name: "New", prompt: "", botId: "bot-1" })).toThrow(/That MAUS no longer exists/);
    expect(m.test(blindActor, created.webhook.id)).toBeNull();
    expect(m.rotateSecret(blindActor, created.webhook.id)).toBeNull();
    expect(m.update(blindActor, created.webhook.id, { name: "Updated" })).toBeNull();
    expect(m.remove(blindActor, created.webhook.id)).toBe(false);
  });
});
