import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CalendarCall } from "../calendar-calls.ts";
import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import type { GroupRecord } from "../store.ts";
import { createCalendarCallRoutes, type CalendarCallRouteDeps } from "./calendar-calls.ts";
import { dispatchRoutes } from "./table.ts";

const call: CalendarCall = {
  id: "c1", name: "Standup", description: "", botIds: ["a", "b"],
  schedule: { type: "once", at: 1 }, durationMinutes: 30, attachments: [],
  nextRunAt: 1, createdAt: 1, updatedAt: 1,
};
const room = { id: "room", threadId: "thread" } as unknown as GroupRecord;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(deps: Partial<CalendarCallRouteDeps> = {}, state: { exists?: boolean; conflict?: string } = {}): Promise<{ base: string; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>; ensureRoom: ReturnType<typeof vi.fn> }> {
  const calls = {
    list: vi.fn(() => [call]),
    get: vi.fn(() => state.exists === false ? null : call),
    create: vi.fn((input: unknown) => ({ ...call, ...input as object })),
    update: vi.fn((id: string, patch: object) => ({ ...call, id, ...patch })),
    remove: vi.fn(() => state.exists !== false),
  };
  const ensureRoom = vi.fn(() => room);
  const routes = [createCalendarCallRoutes({
    calls,
    audienceConflict: () => state.conflict ?? null,
    ensureRoom,
    roomView: () => ({ id: "room" }),
    messages: () => [{ id: "m1" }],
    ...deps,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      json(res, typeof status === "number" ? status : 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, create: calls.create, update: calls.update, remove: calls.remove, ensureRoom };
}

const post = (base: string, path: string, body: unknown = { name: "Standup", botIds: ["a", "b"], schedule: { type: "once", at: 1 } }) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the calendar-calls module through the route table", () => {
  it("lists calls and creates one with the audience check", async () => {
    const { base, create } = await serve();
    const listed = await fetch(`${base}/api/calendar-calls`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ calls: [call] });

    const body = { name: "Standup", botIds: ["a", "b"], schedule: { type: "once", at: 1 } };
    const created = await post(base, "/api/calendar-calls", body);
    expect(created.status).toBe(201);
    expect((await created.json() as { call: CalendarCall }).call).toMatchObject(body);
    expect(create).toHaveBeenCalledWith(body);
  });

  it("refuses a conflicting audience and maps a create failure to 400", async () => {
    const conflicted = await serve({}, { conflict: "not the same audience" });
    const refused = await post(conflicted.base, "/api/calendar-calls");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "not the same audience" });

    const failing = await serve({ calls: {
      list: () => [], get: () => call, create: () => { throw new Error("bad input"); },
      update: () => call, remove: () => true,
    } });
    const failed = await post(failing.base, "/api/calendar-calls");
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "bad input" });
  });

  it("opens a room only for a multi-bot call that exists", async () => {
    const { base, ensureRoom } = await serve();
    const opened = await post(base, "/api/calendar-calls/c1/room");
    expect(opened.status).toBe(200);
    expect(await opened.json()).toEqual({ group: { id: "room", messages: [{ id: "m1" }] } });
    expect(ensureRoom).toHaveBeenCalledWith(call);
    await serve({}, { exists: false }).then(async ({ base: missing }) => {
      const none = await post(missing, "/api/calendar-calls/c1/room");
      expect(none.status).toBe(404);
      expect(await none.json()).toEqual({ error: "no such scheduled call" });
    });
    const single = await serve({ calls: {
      list: () => [], get: () => ({ ...call, botIds: ["a"] }),
      create: () => call, update: () => call, remove: () => true,
    } });
    const refused = await post(single.base, "/api/calendar-calls/c1/room");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "single-bot events open that bot's chat directly" });
  });

  it("patches and deletes existing calls, with 404 for a missing one", async () => {
    const { base, update, remove } = await serve();
    const patch = await fetch(`${base}/api/calendar-calls/c1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Sync" }) });
    expect(patch.status).toBe(200);
    expect((await patch.json() as { call: CalendarCall }).call).toMatchObject({ id: "c1", name: "Sync" });
    expect(update).toHaveBeenCalledWith("c1", { name: "Sync" });

    const deleted = await fetch(`${base}/api/calendar-calls/c1`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith("c1");

    const missing = await serve({}, { exists: false });
    for (const method of ["PATCH", "DELETE"]) {
      const response = await fetch(`${missing.base}/api/calendar-calls/c1`, { method, headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status, method).toBe(404);
      expect(await response.json()).toEqual({ error: "no such scheduled call" });
    }
  });

  it("refuses a conflicting patch and maps an update failure to 400", async () => {
    const conflicted = await serve({}, { conflict: "not the same audience" });
    const refused = await fetch(`${conflicted.base}/api/calendar-calls/c1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "not the same audience" });

    const failing = await serve({ calls: {
      list: () => [], get: () => call, create: () => call,
      update: () => { throw new Error("bad patch"); }, remove: () => true,
    } });
    const failed = await fetch(`${failing.base}/api/calendar-calls/c1`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "bad patch" });
  });

  it("passes on paths and methods it does not own", async () => {
    const { base } = await serve();
    for (const [method, path] of [["GET", "/api/calendar-calls/c1"], ["PUT", "/api/calendar-calls"], ["POST", "/api/calendar-calls/nope"], ["GET", "/api/calendar-calls/nope/room"]]) {
      const response = await fetch(`${base}${path}`, { method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json(), `${method} ${path}`).toEqual({ from: "inline routes" });
    }
  });

  it("stays behind the admin scope gate", () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect(requiredScope(method, "/api/calendar-calls"), method).toBe("admin");
    }
  });
});
