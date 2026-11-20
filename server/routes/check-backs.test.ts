import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCheckBacks } from "../host/check-backs.ts";
import type { RequestAuth } from "../request-auth.ts";
import { CHECK_BACK_MESSAGES, checkBackRefusal, createCheckBackRoutes, createCheckBackToolRoutes, type CheckBackTurnFacts } from "./check-backs.ts";
import { PASS, type RouteContext } from "./table.ts";

const T0 = Date.UTC(2026, 10, 19, 14, 0);
const auth = { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function ctx(path: string, method: string, body?: unknown) {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const context = { req: {} as RouteContext["req"], res: {} as RouteContext["res"], url: new URL(`http://x${path}`), path, method, auth,
    json: ((_res: unknown, status: number, value: Record<string, unknown>) => { sent.status = status; sent.body = value; }) as unknown as RouteContext["json"],
    readBody: (async () => body) as unknown as RouteContext["readBody"] } as RouteContext;
  return { context, sent };
}

function setup(refusal: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-back-routes-"));
  dirs.push(dir);
  const checkBacks = createCheckBacks({ dataDir: dir, now: () => T0, alive: () => true, busy: () => false, line: (record) => `line-${record.id}`, start: async () => {}, log: () => {} });
  let body: unknown;
  const tool = createCheckBackToolRoutes({
    checkBacks, requireActive: () => {}, botId: () => "scout", threadId: () => "t1", refusal: () => refusal, zone: () => "America/New_York",
    origin: () => ({ kind: "user", request: "watch CI" }), readBody: async () => body, now: () => T0,
  });
  const call = async (args: unknown) => {
    body = args;
    const { context, sent } = ctx("/api/internal/check-backs", "POST", args);
    await tool(context);
    return sent;
  };
  return { checkBacks, call };
}

const person: CheckBackTurnFacts = { owned: true, room: false, depth: 0, handedOff: false, routineRun: false, outsideDriven: false, personStarted: true, guest: false };

describe("checkBackRefusal", () => {
  it("lets the person's own turn in a one-to-one chat set one", () => {
    expect(checkBackRefusal(person)).toBeNull();
  });

  it("refuses rooms, guests, handed-on work, routines and outside events with a line for the bot", () => {
    expect(checkBackRefusal({ ...person, owned: false })).toBe(CHECK_BACK_MESSAGES.notYours);
    expect(checkBackRefusal({ ...person, room: true })).toBe(CHECK_BACK_MESSAGES.room);
    expect(checkBackRefusal({ ...person, guest: true })).toBe(CHECK_BACK_MESSAGES.guest);
    for (const facts of [{ depth: 1 }, { handedOff: true }, { routineRun: true }, { outsideDriven: true }, { personStarted: false }]) {
      expect(checkBackRefusal({ ...person, ...facts })).toBe(CHECK_BACK_MESSAGES.notPerson);
    }
  });
});

describe("check_back tool route", () => {
  it("passes other paths", async () => {
    const { checkBacks } = setup();
    const tool = createCheckBackToolRoutes({ checkBacks, requireActive: () => {}, botId: () => "b", threadId: () => "t", refusal: () => null, zone: () => "UTC", origin: () => ({ kind: "outside" }), readBody: async () => ({}) });
    expect(await tool(ctx("/api/internal/waits", "POST").context)).toBe(PASS);
  });

  it("sets one in the person's zone, applies at once with nobody asked, lists and cancels it", async () => {
    const { checkBacks, call } = setup();
    const made = await call({ when: "Friday 9am", note: "chase the client", if: "they haven't replied" });
    expect(made.status).toBe(201);
    expect(String(made.body?.text)).toContain("Fri 20 Nov 09:00 (America/New_York; 2026-11-20T14:00:00.000Z)");
    const [record] = checkBacks.list("scout", "t1");
    expect(record).toMatchObject({ note: "chase the client", condition: "they haven't replied", dueAt: Date.UTC(2026, 10, 20, 14, 0), origin: { kind: "user", request: "watch CI" } });
    const listed = await call({});
    expect(String(listed.body?.text)).toContain(record!.id);
    const cancelled = await call({ cancel: record!.id });
    expect(cancelled.status).toBe(200);
    expect(checkBacks.list("scout", "t1")).toEqual([]);
    expect((await call({ cancel: "nope" })).status).toBe(404);
  });

  it("cancels them all", async () => {
    const { checkBacks, call } = setup();
    await call({ when: "in 10 minutes", note: "one" });
    await call({ when: "in 20 minutes", note: "two" });
    expect((await call({ cancel: "all" })).body?.text).toContain("Cancelled 2 check-backs");
    expect(checkBacks.list("scout", "t1")).toEqual([]);
  });

  it("refuses with a short line to the bot, never an ask", async () => {
    const { call } = setup();
    expect(await call({ when: "in 30 seconds", note: "x" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("less than a minute") } });
    expect(await call({ when: "in 100 days", note: "x" })).toMatchObject({ status: 409, body: { error: expect.stringContaining("90 days") } });
    expect(await call({ when: "someday", note: "x" })).toMatchObject({ status: 400, body: { error: expect.stringContaining("when:") } });
    expect(await call({ when: "in 1 hour" })).toMatchObject({ status: 400 });
    expect(await call({ when: "in 1 hour", note: "x", extra: 1 })).toMatchObject({ status: 400 });
    const refused = setup(CHECK_BACK_MESSAGES.room);
    expect(await refused.call({ when: "in 1 hour", note: "x" })).toMatchObject({ status: 403, body: { error: CHECK_BACK_MESSAGES.room } });
  });
});

describe("the line's Cancel", () => {
  it("cancels for someone who may act in that chat, and 404s for anyone who can't see it", async () => {
    const { checkBacks, call } = setup();
    await call({ when: "in 1 hour", note: "x" });
    const [record] = checkBacks.list("scout", "t1");
    const hidden = createCheckBackRoutes({ checkBacks, sees: () => false, refusal: () => null });
    const blocked = createCheckBackRoutes({ checkBacks, sees: () => true, refusal: () => "Only the person who started this conversation or sent this request, or a workspace admin, can answer this card." });
    const allowed = createCheckBackRoutes({ checkBacks, sees: () => true, refusal: () => null });
    const path = `/api/check-backs/${record!.id}/cancel`;
    const a = ctx(path, "POST"); await hidden(a.context); expect(a.sent.status).toBe(404);
    const b = ctx(path, "POST"); await blocked(b.context); expect(b.sent.status).toBe(403);
    expect(checkBacks.list("scout", "t1")).toHaveLength(1);
    const c = ctx(path, "POST"); await allowed(c.context); expect(c.sent.status).toBe(200);
    expect(checkBacks.list("scout", "t1")).toEqual([]);
    const d = ctx(path, "POST"); await allowed(d.context); expect(d.sent.status).toBe(404);
  });
});
