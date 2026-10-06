import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InkboxSetupInput, InkboxSetupSnapshot } from "../../shared/inkbox-setup.ts";
import { json, readBody } from "../harness/http.ts";
import { InkboxSetupError } from "../inkbox-provider.ts";
import { resolveRequestAuth, type RequestAuth } from "../request-auth.ts";
import { SessionRegistry } from "../sessions.ts";
import { createInkboxSetupRoutes, type InkboxSetupRouteDeps } from "./inkbox-setup.ts";
import { dispatchRoutes } from "./table.ts";

const root = "/api/inkbox/setup";
const input = { apiKey: "fixture-secret-not-public", botId: "fixture-bot", ownerPhone: "+14155550199" };
const resources: Array<{ server: Server; sessions: SessionRegistry; directory: string }> = [];
afterEach(async () => {
  for (const { server, sessions, directory } of resources.splice(0)) {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    sessions.close(); rmSync(directory, { recursive: true, force: true });
  }
});

async function fixture(options: { available?: boolean; auth?: RequestAuth; loopbackTrust?: "owner" | "service"; error?: Error } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omb-inkbox-routes-"));
  const sessions = new SessionRegistry({ file: join(directory, "sessions.json") });
  const admin = sessions.issue({ label: "Fixture remote admin", scopes: ["admin", "client"] });
  const client = sessions.issue({ label: "Fixture client", scopes: ["client"] });
  let snapshot: InkboxSetupSnapshot = { available: options.available ?? true, phase: "disconnected", canReconnect: false, deliveries: [] };
  const calls: Array<{ operation: string; input?: InkboxSetupInput }> = [];
  const setup: InkboxSetupRouteDeps["setup"] = {
    snapshot: () => structuredClone(snapshot),
    async setup(value) {
      calls.push({ operation: "setup", input: value });
      if (options.error) throw options.error;
      await new Promise(resolve => setImmediate(resolve));
      snapshot = { ...snapshot, phase: "awaiting_phone", botId: value.botId, ownerPhone: value.ownerPhone, canReconnect: true };
    },
    async reconnect() {
      calls.push({ operation: "reconnect" }); if (options.error) throw options.error;
      await new Promise(resolve => setImmediate(resolve)); snapshot.phase = "awaiting_phone";
    },
    async disconnect() {
      calls.push({ operation: "disconnect" }); if (options.error) throw options.error;
      await new Promise(resolve => setImmediate(resolve)); snapshot.phase = "disconnected";
    },
  };
  const route = createInkboxSetupRoutes({ setup });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const gate = resolveRequestAuth(req, { sessions, cookieName: "fixture_session", streamPath: "/events", url,
        loopbackTrust: options.loopbackTrust ?? "owner", ...(options.loopbackTrust === "service" ? {} : { loopbackMutationToken: "fixture-desktop-owner" }) });
      const auth = options.auth ?? gate.auth;
      if (!auth) return json(res, gate.status, { error: gate.error });
      const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { error: "fixture fallback" });
    })().catch(() => json(res, 500, { error: "fixture uncaught error" }));
  });
  resources.push({ server, sessions, directory });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const send = async (path = root, method = "GET", body?: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: {
      "content-type": "application/json", "x-openmausbot-desktop-owner": "fixture-desktop-owner", ...headers,
    }, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(5_000) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { send, calls, admin, client };
}

describe("local desktop Inkbox setup routes over HTTP", () => {
  it("returns uncached public status and awaits each lifecycle operation before responding", async () => {
    const f = await fixture();
    const initial = await f.send();
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(initial.body).toEqual({ available: true, phase: "disconnected", canReconnect: false, deliveries: [] });
    const configured = await f.send(root, "POST", JSON.stringify(input));
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ phase: "awaiting_phone", ownerPhone: input.ownerPhone, botId: input.botId });
    expect(JSON.stringify(configured.body)).not.toContain(input.apiKey);
    expect((await f.send(`${root}/disconnect`, "POST")).body).toMatchObject({ phase: "disconnected" });
    expect((await f.send(`${root}/reconnect`, "POST")).body).toMatchObject({ phase: "awaiting_phone" });
    expect(f.calls).toEqual([{ operation: "setup", input }, { operation: "disconnect" }, { operation: "reconnect" }]);
  });

  it("denies paired admin and client sessions even when they reach loopback", async () => {
    const f = await fixture();
    for (const token of [f.admin.token, f.client.token]) {
      for (const [method, path] of [["GET", root], ["POST", root], ["POST", `${root}/reconnect`], ["POST", `${root}/disconnect`]]) {
        const response = await f.send(path, method, method === "POST" ? JSON.stringify(input) : undefined, { authorization: `Bearer ${token}` });
        expect(response.status).toBe(403);
        expect(JSON.stringify(response.body)).not.toContain(input.apiKey);
      }
    }
    expect(f.calls).toEqual([]);
  });

  it("requires non-service loopback admin auth at the route boundary", async () => {
    for (const auth of [{ kind: "loopback", scopes: ["admin", "client"], trust: "service" }, { kind: "loopback", scopes: ["client"] }] as const) {
      const f = await fixture({ auth });
      expect((await f.send(root, "POST", JSON.stringify(input))).status).toBe(403);
      expect(f.calls).toEqual([]);
    }
  });

  it("denies proxy requests, service loopback, and desktop mutations lacking its private capability", async () => {
    const f = await fixture();
    expect((await f.send(root, "POST", JSON.stringify(input), { "x-openmausbot-desktop-owner": "" })).status).toBe(403);
    expect((await f.send(root, "GET", undefined, { "x-forwarded-host": "remote.example" })).status).toBe(403);
    const service = await fixture({ loopbackTrust: "service" });
    expect((await service.send(root, "POST", JSON.stringify(input))).status).toBe(403);
    expect([...f.calls, ...service.calls]).toEqual([]);
  });

  it("reports unavailable desktop setup on reads and refuses its mutations", async () => {
    const f = await fixture({ available: false });
    expect(await f.send()).toMatchObject({ status: 200, body: { available: false } });
    for (const path of [root, `${root}/reconnect`, `${root}/disconnect`]) {
      expect((await f.send(path, "POST", JSON.stringify(input))).status).toBe(503);
    }
    expect(f.calls).toEqual([]);
  });

  it("rejects malformed and oversized JSON without echoing the API key or invoking setup", async () => {
    const f = await fixture();
    const malformed = await f.send(root, "POST", `{"apiKey":"${input.apiKey}"`);
    expect(malformed.status).toBe(400);
    expect(JSON.stringify(malformed.body)).not.toContain(input.apiKey);
    const oversized = await f.send(root, "POST", JSON.stringify({ ...input, apiKey: input.apiKey.repeat(1000) }));
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(oversized.body)).not.toContain(input.apiKey);
    expect(f.calls).toEqual([]);
  });

  it("returns safe application errors and redacts unexpected provider failures", async () => {
    const known = await fixture({ error: new InkboxSetupError("Choose an existing bot.", 409) });
    expect(await known.send(root, "POST", JSON.stringify(input))).toMatchObject({ status: 409, body: { error: "Choose an existing bot." } });
    const broken = await fixture({ error: new Error(`provider rejected bearer ${input.apiKey}`) });
    for (const path of [root, `${root}/reconnect`, `${root}/disconnect`]) {
      const response = await broken.send(path, "POST", JSON.stringify(input));
      expect(response.status).toBe(503);
      expect(JSON.stringify(response.body)).not.toContain(input.apiKey);
    }
  });

  it("declines unrelated paths and rejects unsupported methods without changing setup", async () => {
    const f = await fixture();
    expect((await f.send("/api/inkbox/setup-extra")).body).toEqual({ error: "fixture fallback" });
    expect((await f.send(`${root}/nested`)).body).toEqual({ error: "fixture fallback" });
    expect((await f.send(root, "DELETE")).status).toBe(405);
    expect((await f.send(`${root}/reconnect`)).status).toBe(405);
    expect(f.calls).toEqual([]);
  });
});
