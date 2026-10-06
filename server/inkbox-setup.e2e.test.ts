import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { InkboxSetupSnapshot } from "../shared/inkbox-setup.ts";
import { validInkboxSecretDocument } from "../electron/inkbox-credentials.mjs";
import { json, readBody } from "./harness/http.ts";
import { InkboxChannel } from "./inkbox-channel.ts";
import { InkboxSetup } from "./inkbox-setup.ts";
import { createInkboxTunnelHandler } from "./inkbox-tunnel.ts";
import { resolveRequestAuth } from "./request-auth.ts";
import { createInkboxSetupRoutes } from "./routes/inkbox-setup.ts";
import { dispatchRoutes, type RouteHandler } from "./routes/table.ts";
import { SessionRegistry } from "./sessions.ts";

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const OWNER = "+14155550199";
const BOT = "b1111111-1111-4111-8111-111111111111";
const IDENTITY = "a1111111-1111-4111-8111-111111111111";
const TUNNEL = "c1111111-1111-4111-8111-111111111111";
const SUBSCRIPTION = "d1111111-1111-4111-8111-111111111111";
const ADMIN_KEY = "fixture-admin-key";
const RUNTIME_KEY = "fixture-scoped-runtime-key";
const SIGNING_KEY = "fixture-webhook-signing-key";

it("connects desktop setup to signed ingress and one durable reply, preserving duplicates across pause and reconnect", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-inkbox-setup-e2e-"));
  const sessions = new SessionRegistry({ file: join(directory, "sessions.json") });
  let setup!: InkboxSetup;
  let route!: RouteHandler;
  let saved: unknown = null;
  let handle = "";
  let signingConfigured = false;
  let tunnelOpens = 0;
  let tunnelCloses = 0;
  const ownerCalls: Array<{ id: string; text: string }> = [];
  const channels: InkboxChannel[] = [];
  const files: string[] = [];
  const handlers: ReturnType<typeof createInkboxTunnelHandler>[] = [];
  const providerCalls: Array<{ path: string; method: string; key: string | null; body: unknown }> = [];
  const outbound: Array<{ to: string; text: string }> = [];
  const tunnel = () => ({ id: TUNNEL, tunnel_name: handle, agent_identity_id: IDENTITY,
    public_host: `${handle}.inkboxwire.com`, zone: "inkboxwire.com", tls_mode: "edge", status: "active" });
  const identity = () => ({ id: IDENTITY, agent_handle: handle, status: "active", imessage_enabled: true,
    signing_key_configured: signingConfigured, tunnel: tunnel() });

  // Replace only external provider transport. The coordinator, API validation,
  // signed receiver, credential scope checks and outbound channel are real.
  const providerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://inkbox.ai");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const method = init?.method ?? "GET";
    const key = new Headers(init?.headers).get("X-API-Key");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    providerCalls.push({ path: url.pathname, method, key, body });
    if (url.pathname === "/api/v1/api-keys/self" && method === "GET") {
      expect([ADMIN_KEY, RUNTIME_KEY]).toContain(key);
      return Response.json({ status: "active", scoped_identity_id: key === ADMIN_KEY ? null : IDENTITY });
    }
    if (url.pathname === "/api/v1/identities" && method === "POST") {
      expect(key).toBe(ADMIN_KEY);
      expect(body).toMatchObject({ display_name: "Mausbot", imessage_enabled: true });
      handle = body.agent_handle;
      return Response.json(identity(), { status: 201 });
    }
    if (url.pathname === "/api/v1/api-keys" && method === "POST") {
      expect(key).toBe(ADMIN_KEY);
      expect(body.scoped_identity_id).toBe(IDENTITY);
      return Response.json({ api_key: RUNTIME_KEY, record: { status: "active", scoped_identity_id: IDENTITY } }, { status: 201 });
    }
    if (url.pathname === `/api/v1/identities/${handle}` && method === "GET") {
      expect([ADMIN_KEY, RUNTIME_KEY]).toContain(key); return Response.json(identity());
    }
    if (url.pathname === `/api/v1/tunnels/${TUNNEL}` && method === "GET") {
      expect([ADMIN_KEY, RUNTIME_KEY]).toContain(key); return Response.json({ ...tunnel(), currently_connected: false });
    }
    expect(key).toBe(RUNTIME_KEY);
    if (url.pathname === "/api/v1/webhooks/subscriptions" && method === "POST") {
      expect(body).toEqual({ agent_identity_id: IDENTITY, url: `https://${handle}.inkboxwire.com/inkbox`, event_types: expect.arrayContaining(["imessage.received", "message.received", "text.received", "slack.dm_received", "call.ended", "a2a.task.created"]) });
      signingConfigured = true;
      return Response.json({ ...body, id: SUBSCRIPTION, signing_key: SIGNING_KEY }, { status: 201 });
    }
    if (url.pathname === "/api/v1/imessage/triage-number" && method === "GET") {
      return Response.json({ number: "+15555550123", connect_command: `connect @${handle}` });
    }
    if (url.pathname === "/api/v1/imessage/messages" && method === "POST") {
      // Outbound delivery may happen only after its sending receipt is durable.
      expect(JSON.parse(readFileSync(files.at(-1)!, "utf8"))).toMatchObject({ deliveries: [{ id: "evt_setup_fixture", status: "sending", reply: "Hello from the fixture bot." }] });
      outbound.push(body);
      return Response.json({ id: "fixture-outbound-message" }, { status: 201 });
    }
    throw new Error(`Unexpected synthetic provider request: ${method} ${url.pathname}`);
  };

  const server = createServer((req, res) => {
    void (async () => {
      if (await setup.handle(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const gate = resolveRequestAuth(req, { sessions, cookieName: "fixture_session", streamPath: "/events", url,
        loopbackMutationToken: "fixture-desktop-capability" });
      if (!gate.auth) return json(res, gate.status, { error: gate.error });
      if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: gate.auth, json, readBody })) {
        json(res, 404, { error: "fixture route not found" });
      }
    })().catch(() => json(res, 500, { error: "fixture server failure" }));
  });

  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    setup = new InkboxSetup({ directory, port, botExists: id => id === BOT, fetch: providerFetch,
      secrets: { available: true, read: async () => structuredClone(saved), write: async value => {
        expect(value === null || validInkboxSecretDocument(value)).toBe(true);
        saved = structuredClone(value);
      } },
      makeChannel(config, file, active) {
        files.push(file);
        const channel = new InkboxChannel({ config, file, now: () => NOW, fetch: providerFetch,
          contactForPhone: () => null,
          onOwner: async (id, text) => { expect(active()).toBe(true); ownerCalls.push({ id, text }); return "Hello from the fixture bot."; },
          onContact: async () => { throw new Error("The fixture owner must never enter contact routing"); },
        });
        channels.push(channel); return channel;
      },
      tunnel: async options => {
        tunnelOpens++;
        expect(options.apiKey).toBe(RUNTIME_KEY);
        // This production handler forwards through a real loopback HTTP socket;
        // no SDK connection, credential enrollment or public provider is opened.
        handlers.push(createInkboxTunnelHandler({ handle: options.handle, port: options.port, active: options.active }));
        let finish!: () => void;
        const waiting = new Promise<void>(resolve => { finish = resolve; });
        return { isConnected: true, wait: () => waiting, close: async () => { tunnelCloses++; finish(); } };
      },
    });
    route = createInkboxSetupRoutes({ setup });
    await setup.restore();
    const api = async (path: string, body?: unknown) => {
      const response = await fetch(`${base}/api/inkbox/setup${path}`, { method: "POST",
        headers: { "content-type": "application/json", "x-openmausbot-desktop-owner": "fixture-desktop-capability" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
      const snapshot = await response.json() as InkboxSetupSnapshot;
      expect(response.status, JSON.stringify(snapshot)).toBe(200);
      expect(JSON.stringify(snapshot)).not.toMatch(/fixture-admin-key|fixture-scoped-runtime-key|fixture-webhook-signing-key/);
      return snapshot;
    };
    const ready = await api("", { apiKey: ADMIN_KEY, botId: BOT, ownerPhone: OWNER });
    expect(ready).toMatchObject({ phase: "awaiting_phone", pairing: { number: "+15555550123" }, deliveries: [] });
    expect(saved).toMatchObject({ apiKey: RUNTIME_KEY, signingSecret: SIGNING_KEY, enabled: true, stage: "ready" });

    const payload = JSON.stringify({ id: "evt_setup_fixture", event_type: "imessage.received", timestamp: new Date(NOW).toISOString(),
      agent_identity_id: IDENTITY, data: { message: { id: "message-setup-fixture", direction: "inbound", conversation_id: "conversation-fixture",
        is_group: false, participants: null, recipients: null, remote_number: OWNER, sender_number: null, content: "hello", message_type: "message" } } });
    const stamp = String(Math.floor(NOW / 1000));
    const headers = { "content-type": "application/json", "x-inkbox-request-id": "request-fixture", "x-inkbox-timestamp": stamp,
      "x-inkbox-signature": `sha256=${createHmac("sha256", SIGNING_KEY).update(`request-fixture.${stamp}.`).update(payload).digest("hex")}` };
    const inbound = () => new Request(`https://${handle}.inkboxwire.com/inkbox`, { method: "POST", headers, body: payload });
    const firstHandler = handlers[0]!;
    expect((await firstHandler(new Request(`https://${handle}.inkboxwire.com/api/config`, { method: "POST", headers, body: payload }))).status).toBe(404);
    expect((await firstHandler(new Request(`https://${handle}.inkboxwire.com/inkbox`, { method: "POST", headers: { ...headers, "x-inkbox-signature": `sha256=${"0".repeat(64)}` }, body: payload }))).status).toBe(403);
    expect(ownerCalls).toEqual([]);
    expect((await firstHandler(inbound())).status).toBe(202);
    await channels.at(-1)!.idle();
    expect(ownerCalls).toEqual([{ id: "evt_setup_fixture", text: "hello" }]);
    expect(outbound).toEqual([{ to: OWNER, text: "Hello from the fixture bot." }]);
    expect(setup.snapshot()).toMatchObject({ phase: "connected", deliveries: [{ id: "evt_setup_fixture", status: "sent" }] });
    expect((await firstHandler(inbound())).status).toBe(202);
    await channels.at(-1)!.idle();
    expect(ownerCalls).toHaveLength(1); expect(outbound).toHaveLength(1);
    const receiptBeforePause = readFileSync(files[0]!, "utf8");
    expect(receiptBeforePause).not.toMatch(/fixture-admin-key|fixture-scoped-runtime-key|fixture-webhook-signing-key/);

    expect(await api("/disconnect")).toMatchObject({ phase: "disconnected" });
    expect(tunnelCloses).toBe(1);
    expect((await firstHandler(inbound())).status).toBe(503);
    const pausedIngress = await fetch(`${base}/inkbox`, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(5_000) });
    expect(pausedIngress.status).toBe(503); await pausedIngress.body?.cancel();

    expect(await api("/reconnect")).toMatchObject({ phase: "connected", deliveries: [{ id: "evt_setup_fixture", status: "sent" }] });
    expect(tunnelOpens).toBe(2);
    expect(files[1]).toBe(files[0]);
    expect(readFileSync(files[1]!, "utf8")).toBe(receiptBeforePause);
    expect((await firstHandler(inbound())).status).toBe(503);
    expect((await handlers[1]!(inbound())).status).toBe(202);
    await channels.at(-1)!.idle();
    expect(ownerCalls).toHaveLength(1); expect(outbound).toHaveLength(1);
    expect(providerCalls.filter(call => call.method === "POST").map(call => call.path)).toEqual([
      "/api/v1/identities", "/api/v1/api-keys", "/api/v1/webhooks/subscriptions", "/api/v1/imessage/messages",
    ]);
  } finally {
    await setup?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    sessions.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
