import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadEnterpriseLayer } from "../enterprise.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope, serviceAllowed, type RequestAuth } from "../request-auth.ts";
import { licenseStateProof, LICENSE_PROOF_HEADER } from "../license-proof.ts";
import { registerSeatSources } from "../license-seats.ts";
import { LICENSE_PATH, licenseRoutes, resetLicenseRouteForTests } from "./license.ts";
import { dispatchRoutes, ROUTES } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await loadEnterpriseLayer({ dir: join(tmpdir(), "omb-enterprise-absent"), licenseKey: undefined });
  resetLicenseRouteForTests();
  registerSeatSources(null);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(auth: RequestAuth): Promise<string> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(ROUTES, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const session = (scopes: ("admin" | "client")[]): RequestAuth =>
  ({ kind: "session", via: "bearer", scopes, session: {} as never });

describe("GET /api/license", () => {
  it("is listed with the other routes, needs the admin scope, and is never open to a bot shell", () => {
    expect(ROUTES).toContain(licenseRoutes);
    expect(requiredScope("GET", LICENSE_PATH)).toBe("admin");
    expect(serviceAllowed("GET", LICENSE_PATH)).toBe(false);
  });

  it("tells the owner the licence state, and never the key", async () => {
    const layer = mkdtempSync(join(tmpdir(), "omb-license-route-layer-"));
    const data = mkdtempSync(join(tmpdir(), "omb-license-route-data-"));
    dirs.push(layer, data);
    mkdirSync(join(layer, "server"));
    writeFileSync(join(layer, "server", "index.js"),
      `export function register({ licenseKey }) { return { customer: "Acme", features: ["budgets"], expiresAt: "2099-01-01", seats: 20, plan: "business-server", sub: "sub_secret_id", server: licenseKey.slice(0, 4) }; }`);
    const key = "omb1.eyJjbGFpbXMiOnRydWV9.c2lnbmF0dXJl";
    writeFileSync(join(data, "license.key"), key);
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });

    const base = await serve({ kind: "loopback", scopes: ["admin", "client"] });
    const response = await fetch(`${base}/api/license`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      valid: true, source: "file", customer: "Acme", plan: "business-server", seats: 20, features: ["budgets"],
      expiresAt: "2099-01-01", graceEndsAt: "2099-01-15", graceDaysLeft: null, notice: null,
    });
    expect(text).not.toContain("omb1");
    expect(text).not.toContain("c2lnbmF0dXJl");
    expect(text).not.toContain("sub_secret_id");
    expect((await fetch(`${base}/api/license`, { method: "POST" })).status).toBe(405);

    const admin = await serve(session(["admin", "client"]));
    expect((await fetch(`${admin}/api/license`)).status).toBe(200);
  });

  it("answers an unlicensed server too: not valid, nothing held", async () => {
    const base = await serve({ kind: "loopback", scopes: ["admin", "client"] });
    expect(await (await fetch(`${base}/api/license`)).json()).toEqual({
      valid: false, source: null, customer: null, plan: null, seats: null, features: [],
      expiresAt: null, expiresInDays: null, graceEndsAt: null, graceDaysLeft: null, notice: null,
      seatsUsed: null, files: false, connected: false,
    });
  });

  it("refuses a bot shell on a shared server and a chat-only session", async () => {
    for (const auth of [{ kind: "loopback", scopes: ["client"], trust: "service" } as RequestAuth, session(["client"])]) {
      const base = await serve(auth);
      const response = await fetch(`${base}/api/license`);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("valid");
    }
  });

  async function licensed(key = "omb1.eyJjbGFpbXMiOnRydWV9.c2lnbmF0dXJl") {
    const layer = mkdtempSync(join(tmpdir(), "omb-license-route-layer-"));
    const data = mkdtempSync(join(tmpdir(), "omb-license-route-data-"));
    dirs.push(layer, data);
    mkdirSync(join(layer, "server"));
    writeFileSync(join(layer, "server", "index.js"),
      `export function register() { return { customer: "Acme Analytical", features: ["budgets"], expiresAt: "2099-01-01", seats: 20, plan: "business-server" }; }`);
    writeFileSync(join(data, "license.key"), key);
    await loadEnterpriseLayer({ dir: layer, dataDir: data, licenseKey: undefined });
    return key;
  }
  const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

  it("answers the MausBot connector on a shared server six fields of state, only for a digest of a licence this server accepted", async () => {
    const key = await licensed();
    const base = await serve(service);
    const read = (proof?: string) => fetch(`${base}/api/license`, proof === undefined ? {} : { headers: { [LICENSE_PROOF_HEADER]: proof } });
    const answer = await read(licenseStateProof(key));
    expect(answer.status).toBe(200);
    const text = await answer.text();
    expect(JSON.parse(text)).toEqual({ valid: true, plan: "business-server", seats: 20, expiresAt: "2099-01-01", graceDaysLeft: null, source: "file" });
    for (const hidden of ["Acme", "budgets", "omb1", "c2lnbmF0dXJl", "seatsUsed"]) expect(text).not.toContain(hidden);
    // A bot's shell knows no licence: a digest of anything else, the key itself, or nothing is refused.
    for (const proof of [undefined, "", licenseStateProof("omb1.other.licence"), key, "0".repeat(64)]) {
      const refused = await read(proof);
      expect(refused.status, String(proof)).toBe(403);
      expect(await refused.text()).not.toContain("valid");
    }
  });

  it("tells the owner the seats in use, that this server reads licence files, and whether the connector delivered the licence", async () => {
    registerSeatSources({ used: () => 23, usedWith: () => 23 });
    const key = await licensed();
    const owner = await serve(session(["admin", "client"]));
    expect(await (await fetch(`${owner}/api/license`)).json()).toMatchObject({ valid: true, seats: 20, seatsUsed: 23, files: true, connected: false });
    // The connector's read marks the licence as delivered by MausBot; an owner's own read with a digest counts as well.
    const connector = await serve(service);
    expect((await fetch(`${connector}/api/license`, { headers: { [LICENSE_PROOF_HEADER]: licenseStateProof(key) } })).status).toBe(200);
    expect(await (await fetch(`${owner}/api/license`)).json()).toMatchObject({ source: "file", connected: true });
  });
});
