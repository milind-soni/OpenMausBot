import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { denyReason } from "../../companion/src/routes.ts";
import { json, readBody } from "../harness/http.ts";
import type { PhonePushDeviceRegistration } from "../../shared/phone-push.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import type { SessionRecord } from "../sessions.ts";
import { createPhonePushRoutes, type PhonePushRouteDeps } from "./phone-push.ts";
import { dispatchRoutes } from "./table.ts";

const TOKEN = "c3".repeat(32);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const session = (overrides: Partial<SessionRecord> = {}): RequestAuth => ({
  kind: "session",
  via: "bearer",
  scopes: ["client"],
  session: { id: "sess_1", tokenHash: "0".repeat(64), label: "Phone", scopes: ["client"], createdAt: 1, lastSeenAt: 1, expiresAt: 2, ...overrides },
});
const loopback: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const fromPhone = (device = "phone-1") => ({ "x-openmausbot-companion": "1", "x-openmausbot-companion-device": device });

function fakePush() {
  const registered = new Map<string, PhonePushDeviceRegistration>();
  const push: PhonePushRouteDeps["push"] & { registered: typeof registered } = {
    registered,
    status: () => "on",
    device: (key) => {
      const device = registered.get(key);
      return device ? { environment: device.environment, enabled: device.enabled ?? true, updatedAt: 1 } : null;
    },
    register: async (key, input) => {
      registered.set(key, input);
      return { device: push.device(key)!, relay: "registered" };
    },
    remove: async (key) => registered.delete(key),
  };
  return push;
}

async function request(auth: RequestAuth, push: PhonePushRouteDeps["push"], method: string, body?: unknown, headers: Record<string, string> = {}) {
  const routes = [createPhonePushRoutes({ push })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/push/device`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe("/api/push/device", () => {
  it("registers a paired session's phone under that session", async () => {
    const push = fakePush();
    const res = await request(session(), push, "PUT", { token: TOKEN.toUpperCase(), environment: "production", pairing: "pair-tag-1" });
    expect(res).toMatchObject({ status: 200, body: { push: "on", relay: "registered", device: { environment: "production", enabled: true } } });
    // normalized to lowercase hex, keyed by the session that authenticated
    expect(push.registered.get("session:sess_1")).toEqual({ token: TOKEN, environment: "production", pairing: "pair-tag-1" });
    expect(await request(session(), push, "GET")).toMatchObject({ status: 200, body: { device: { environment: "production" } } });
    expect(await request(session(), push, "DELETE")).toEqual({ status: 200, body: { removed: true } });
  });

  it("registers a companion phone under the device the companion vouched for", async () => {
    const push = fakePush();
    expect((await request(loopback, push, "PUT", { token: TOKEN, environment: "sandbox" }, fromPhone())).status).toBe(200);
    expect([...push.registered.keys()]).toEqual(["companion:phone-1"]);
  });

  it("refuses anyone who is not a paired phone: the desktop, a browser sign-in, a forged or malformed device", async () => {
    const push = fakePush();
    const body = { token: TOKEN, environment: "production" };
    expect((await request(loopback, push, "PUT", body)).status).toBe(403);
    expect((await request(loopback, push, "PUT", body, { "x-openmausbot-companion-device": "phone-1" })).status).toBe(403);
    expect((await request(loopback, push, "PUT", body, fromPhone("a/b"))).status).toBe(403);
    expect((await request(session({ cookieOnly: true }), push, "PUT", body)).status).toBe(403);
    expect(push.registered.size).toBe(0);
  });

  it("teaches the shape it wants, and takes no identity or extra field from the body", async () => {
    const push = fakePush();
    const bad = await request(session(), push, "PUT", { token: "not-hex", environment: "production" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toContain('"environment":"production"');
    expect((await request(session(), push, "PUT", { token: TOKEN, environment: "production", key: "session:someone-else" })).status).toBe(400);
    expect((await request(session(), push, "PUT", { token: TOKEN, environment: "staging" })).status).toBe(400);
    expect(push.registered.size).toBe(0);
  });

  it("is a client-scoped route, and the companion forwards exactly its three methods", () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect(requiredScope(method, "/api/push/device")).toBe("client");
      expect(denyReason({ method, path: "/api/push/device", authenticated: true })).toBeNull();
    }
    expect(requiredScope("POST", "/api/push/device")).toBe("admin");
    expect(denyReason({ method: "POST", path: "/api/push/device", authenticated: true })).not.toBeNull();
    expect(denyReason({ method: "PUT", path: "/api/push/device", authenticated: false })?.status).toBe(401);
  });
});
