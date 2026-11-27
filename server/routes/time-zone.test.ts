import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { TIME_ZONE_FILE } from "../time-zone.ts";
import { dispatchRoutes } from "./table.ts";
import { createTimeZoneRoutes } from "./time-zone.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serve(adopts: boolean, dataDir = mkdtempSync(join(tmpdir(), "omb-tz-route-"))) {
  dirs.push(dataDir);
  const changed = vi.fn();
  const routes = [createTimeZoneRoutes({ adopts, dataDir, changed })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, changed, dataDir };
}
const put = (base: string, body: unknown) => fetch(`${base}/api/time-zone`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/time-zone", () => {
  it("on a Cloud home, takes the owner's zone once, tells routines, and answers what it tells time in", async () => {
    vi.stubEnv("TZ", "UTC");
    const { base, changed } = await serve(true);
    expect(await (await fetch(`${base}/api/time-zone`)).json()).toEqual({ timeZone: "UTC", adopts: true });
    const first = await put(base, { timeZone: "Asia/Kolkata" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ timeZone: "Asia/Kolkata", changed: true });
    expect(changed).toHaveBeenCalledExactlyOnceWith("Asia/Kolkata");
    expect(await (await put(base, { timeZone: "Asia/Kolkata" })).json()).toEqual({ timeZone: "Asia/Kolkata", changed: false });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await (await fetch(`${base}/api/time-zone`)).json()).toEqual({ timeZone: "Asia/Kolkata", adopts: true });
  });

  it("refuses an offset or an abbreviation", async () => {
    const { base, changed } = await serve(true);
    for (const timeZone of ["+05:30", "IST", 330]) expect((await put(base, { timeZone })).status).toBe(400);
    expect(changed).not.toHaveBeenCalled();
  });

  it("anywhere but a Cloud home keeps the computer's own zone", async () => {
    const { base, changed } = await serve(false);
    expect(((await (await fetch(`${base}/api/time-zone`)).json()) as { adopts?: boolean }).adopts).toBe(false);
    expect((await put(base, { timeZone: "Asia/Kolkata" })).status).toBe(409);
    expect(changed).not.toHaveBeenCalled();
  });

  it("adopts the zone saved before a restart when it is built", async () => {
    vi.stubEnv("TZ", "UTC");
    const { base, dataDir } = await serve(true);
    await put(base, { timeZone: "Europe/London" });
    vi.stubEnv("TZ", "UTC");
    expect(process.env.TZ).toBe("UTC");
    createTimeZoneRoutes({ adopts: true, dataDir, changed: () => {} });
    expect(process.env.TZ).toBe("Europe/London");
    vi.stubEnv("TZ", "UTC");
    createTimeZoneRoutes({ adopts: false, dataDir, changed: () => {} });
    expect(process.env.TZ).toBe("UTC");
    expect(TIME_ZONE_FILE).toBe("time-zone.json");
  });
});
