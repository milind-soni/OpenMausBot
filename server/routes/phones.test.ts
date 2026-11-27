import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as atomic from "../atomic.ts";
import { json, readBody } from "../harness/http.ts";
import { PhoneJobs } from "../phones/jobs.ts";
import { PhoneRegistry } from "../phones/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhoneRoutes } from "./phones.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(dirs.splice(0).map(removeTempDir));
});

const ADMIN: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const clientSession = (id: string): RequestAuth => ({
  kind: "session", via: "bearer", scopes: ["client"],
  session: { id, cookieOnly: false } as unknown as Extract<RequestAuth, { kind: "session" }>["session"],
});
const companion = (device: string): RequestAuth => ({ kind: "loopback", scopes: ["admin", "client"], companionDevice: device });
const registration = {
  installId: "install-0001", name: "Maus's iPhone", platform: "ios", appVersion: "1.5.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" },
};
const fromPhone = (device = "d1") => ({ "x-openmausbot-companion": "1", "x-openmausbot-companion-device": device });

async function setup(options: { auth?: RequestAuth; owner?: () => string | null; live?: () => boolean; afterBody?: () => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phones-routes-"));
  dirs.push(dir);
  const registry = new PhoneRegistry(join(dir, "phones.json"));
  const jobs = new PhoneJobs();
  const auth = options.auth ?? ADMIN;
  const routes = [createPhoneRoutes({
    registry, jobs, owner: options.owner ?? (() => "owner"), isAdmin: (a) => a.scopes.includes("admin"), live: options.live ?? (() => true),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json,
        readBody: async (request, max) => { const body = await readBody(request, max); options.afterBody?.(); return body; } });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      // index.ts turns an error carrying a status into JSON.
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { registry, jobs, call, dir };
}

describe("phone routes", () => {
  it("a loopback request without the companion marker has no phone key", async () => {
    const { call } = await setup();
    const out = await call("PUT", "/api/phones/self", registration, { "x-openmausbot-companion-device": "d1" });
    expect(out.status).toBe(403);
    expect(out.body.error).toBe("Only a paired phone can register its apps, and only for itself.");
  });

  it("registers from the companion header and lists for the owner", async () => {
    const { call } = await setup({ auth: companion("d1") });
    const put = await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    expect(put.status).toBe(200);
    expect(put.body.phone.key).toBe("companion:d1");
    expect((await call("GET", "/api/phones/self", undefined, fromPhone("d1"))).body.phone.key).toBe("companion:d1");
    const list = await call("GET", "/api/phones");
    expect(list.status).toBe(200);
    expect(list.body.phones).toHaveLength(1);
    expect((await call("PUT", "/api/phones/self", { nope: 1 }, fromPhone("d1"))).status).toBe(400);
  });

  it("a client session registers under its session id", async () => {
    const { call, registry } = await setup({ auth: clientSession("s1") });
    const put = await call("PUT", "/api/phones/self", registration);
    expect(put.status).toBe(200);
    expect(put.body.phone.key).toBe("session:s1");
    expect(registry.get("session:s1")).toBeDefined();
    expect((await call("DELETE", "/api/phones/self")).body).toEqual({ removed: true });
  });

  it("long-polls a job, leases and answers it", async () => {
    const { call, jobs } = await setup({ auth: companion("d1") });
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const outcome = jobs.request("companion:d1", "PHONE_LIST_EVENTS", { days: 1 }, { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true });
    const polled = await call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"));
    expect(polled.status).toBe(200);
    expect(polled.body.job.tool).toBe("PHONE_LIST_EVENTS");
    const id = polled.body.job.id as string;
    expect((await call("POST", `/api/phones/self/jobs/${id}/lease`, {}, fromPhone("d1"))).body).toEqual({ active: true });
    expect((await call("POST", `/api/phones/self/jobs/${id}/result`, { ok: true, result: { events: [] } }, fromPhone("d1"))).body).toEqual({ ok: true });
    expect(await outcome).toEqual({ ok: true, result: { events: [] } });
  });

  it("refuses a result for an unknown job with 409", async () => {
    const { call } = await setup({ auth: companion("d1") });
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const out = await call("POST", "/api/phones/self/jobs/nope/result", { ok: true, result: 1 }, fromPhone("d1"));
    expect(out.status).toBe(409);
    expect((await call("POST", "/api/phones/self/jobs/nope/result", { bad: true }, fromPhone("d1"))).status).toBe(400);
  });

  it("a cookie-only session cannot claim a companion identity", async () => {
    const auth = clientSession("s1");
    if (auth.kind === "session") (auth.session as { cookieOnly?: boolean }).cookieOnly = true;
    const { call } = await setup({ auth });
    expect((await call("PUT", "/api/phones/self", registration, fromPhone("d1"))).status).toBe(403);
  });

  it("plain loopback with companion headers, but no verified device, gets 403 on the poll", async () => {
    const { call } = await setup();
    expect((await call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"))).status).toBe(403);
  });

  it("GET /api/phones needs an admin", async () => {
    const { call } = await setup({ auth: clientSession("s1") });
    expect((await call("GET", "/api/phones")).status).toBe(403);
  });

  it("the phone removing itself fails its waiting jobs and may register again", async () => {
    const { call, jobs } = await setup({ auth: companion("d1") });
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const options = { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true };
    const leased = jobs.request("companion:d1", "PHONE_LIST_EVENTS", {}, options);
    const job = (await call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"))).body.job;
    await call("POST", `/api/phones/self/jobs/${job.id}/lease`, {}, fromPhone("d1"));
    const queued = jobs.request("companion:d1", "PHONE_LIST_EVENTS", {}, options);
    expect((await call("DELETE", "/api/phones/self", undefined, fromPhone("d1"))).body).toEqual({ removed: true });
    const denied = { ok: false, code: "denied", error: "This phone's access changed." };
    expect(await leased).toEqual(denied);
    expect(await queued).toEqual(denied);
    expect(jobs.busy("companion:d1")).toBe(false);
    // A result for the dropped job is refused.
    expect((await call("POST", `/api/phones/self/jobs/${job.id}/result`, { ok: true, result: 1 }, fromPhone("d1"))).status).toBe(409);
    expect((await call("PUT", "/api/phones/self", registration, fromPhone("d1"))).status).toBe(200);
  });

  it("a phone removed on the computer fails its jobs, wakes its poll and is refused until it pairs again", async () => {
    const { call, jobs, registry } = await setup({ auth: companion("d1") });
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const queued = jobs.request("companion:d1", "PHONE_LIST_EVENTS", {}, { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true });
    expect((await call("DELETE", `/api/phones/${encodeURIComponent("companion:d1")}`)).body).toEqual({ removed: true });
    expect(await queued).toEqual({ ok: false, code: "denied", error: "This phone's access changed." });
    expect(registry.blocked("companion:d1")).toBe(true);
    const again = await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    expect(again).toEqual({ status: 403, body: { error: "This phone was removed on the computer. Pair it again to use its apps." } });
    expect((await call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"))).status).toBe(404);
  });

  it.each(["/api/phones/self", "/api/phones/companion%3Ad1"])("reports a failed removal save at %s and still drops jobs", async (path) => {
    const { call, jobs, registry, dir } = await setup({ auth: companion("d1") });
    try {
      await call("PUT", "/api/phones/self", registration);
      const pending = jobs.request("companion:d1", "PHONE_LIST_EVENTS", {}, { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true });
      const job = (await call("GET", "/api/phones/self/jobs")).body.job;
      expect((await call("POST", `/api/phones/self/jobs/${job.id}/lease`)).body).toEqual({ active: true });
      const fault = Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
      const write = vi.spyOn(atomic, "writeFileAtomic").mockImplementation(() => { throw fault; });
      expect((await call("DELETE", path)).status).toBe(500);
      expect(registry.get("companion:d1")).toBeUndefined();
      expect(jobs.busy("companion:d1")).toBe(false);
      expect(await pending).toMatchObject({ ok: false, code: "denied" });
      write.mockRestore();
      expect((await call("DELETE", path)).status).toBe(200);
      const reloaded = new PhoneRegistry(join(dir, "phones.json"));
      expect(reloaded.get("companion:d1")).toBeUndefined();
      expect(reloaded.blocked("companion:d1")).toBe(path !== "/api/phones/self");
    } finally { jobs.close(); }
  });

  it("an open poll answers empty when its phone is removed", async () => {
    const { call, jobs } = await setup({ auth: companion("d1") });
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const poll = call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"));
    await vi.waitFor(() => expect(jobs.polling("companion:d1")).toBe(true));
    jobs.drop("companion:d1", "This phone's access changed.");
    expect(await poll).toEqual({ status: 200, body: { job: null } });
  });

  it("rechecks the session before returning a pending poll's job", async () => {
    let live = true;
    const { call, jobs } = await setup({ auth: clientSession("s1"), live: () => live });
    try {
      await call("PUT", "/api/phones/self", registration);
      const poll = call("GET", "/api/phones/self/jobs");
      await vi.waitFor(() => expect(jobs.polling("session:s1")).toBe(true));
      live = false;
      void jobs.request("session:s1", "PHONE_CREATE_EVENT", { title: "Private appointment" }, { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true });
      expect(await poll).toMatchObject({ status: 401, body: { error: expect.any(String) } });
    } finally { jobs.close(); }
  });

  it("does not register a phone if its session ends while reading the body", async () => {
    let live = true;
    const { call, registry } = await setup({ auth: clientSession("s1"), live: () => live, afterBody: () => { live = false; } });
    expect((await call("PUT", "/api/phones/self", registration)).status).toBe(401);
    expect(registry.get("session:s1")).toBeUndefined();
  });

  it("a team Cloud offers no phones", async () => {
    // A verified phone key, so the refusal comes from there being no owner, not from a missing key.
    const { call } = await setup({ auth: companion("d1"), owner: () => null });
    expect((await call("PUT", "/api/phones/self", registration, fromPhone("d1"))).status).toBe(403);
  });
});
