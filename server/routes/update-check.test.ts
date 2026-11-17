import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import type { ServerUpdater } from "../server-update.ts";
import type { UpdateCheck } from "../update-check.ts";
import { dispatchRoutes } from "./table.ts";
import { createUpdateCheckRoutes } from "./update-check.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(check: () => Promise<UpdateCheck>, updater?: ServerUpdater, auth: RequestAuth = { kind: "loopback", scopes: ["admin"] }): Promise<string> {
  const routes = [createUpdateCheckRoutes({ check, ...(updater ? { server: updater, actor: () => ({ kind: "loopback" as const }) } : {}) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("update check route", () => {
  it("is open to chat-only sessions: it only reads a version", () => {
    expect(requiredScope("GET", "/api/updates/check")).toBe("client");
  });

  it("answers with the check, and leaves other requests to the next handler", async () => {
    const result: UpdateCheck = { current: "0.1.92", install: "docker", latest: "0.1.93", available: true };
    const base = await serve(async () => result);
    const response = await fetch(`${base}/api/updates/check`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect((await fetch(`${base}/api/updates/check`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/updates`)).status).toBe(404);
  });

  it("reports a failed lookup as a 502 with the reason", async () => {
    const base = await serve(async () => { throw new Error("GitHub answered 403"); });
    const response = await fetch(`${base}/api/updates/check`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "Could not check for updates: GitHub answered 403" });
  });

  it("hands the Update server button only an admin's session; loopback and other methods are refused", async () => {
    const asked: string[] = [];
    const server: ServerUpdater = {
      status: async () => { asked.push("status"); return { mode: "button", current: "0.1.150", available: true, activeTurns: 0 }; },
      request: async () => { asked.push("request"); return { status: 202, body: { ok: true } }; },
    };
    const check = async (): Promise<UpdateCheck> => ({ current: "0.1.150", install: "docker", available: true });
    const admin = { kind: "session", session: {}, via: "cookie", scopes: ["admin", "client"] } as unknown as RequestAuth;
    const base = await serve(check, server, admin);
    expect((await fetch(`${base}/api/updates/server`)).status).toBe(200);
    expect((await fetch(`${base}/api/updates/server`, { method: "POST", body: '{"version":"0.0.1","image":"evil"}' })).status).toBe(202);
    expect((await fetch(`${base}/api/updates/server`, { method: "DELETE" })).status).toBe(404);
    expect(asked).toEqual(["status", "request"]);
    const loopback = await serve(check, server);
    const refused = await fetch(`${loopback}/api/updates/server`, { method: "POST" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "admin_only" });
    expect(asked).toEqual(["status", "request"]);
  });
});
