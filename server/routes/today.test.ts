import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";
import { SEES_EVERYTHING, VisibleSet } from "../bot-visibility.ts";
import { DATA_DIR } from "../config.ts";
import { closeMessageDb } from "../message-db.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import { Store } from "../store.ts";
import { createTodayRoutes } from "./today.ts";
import { PASS, type RouteContext } from "./table.ts";

beforeEach(() => {
  closeMessageDb();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

const NOW = new Date(2026, 9, 17, 15, 0).getTime();

function setup() {
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const bot = store.createBot({ name: "Atlas" });
  store.appendMessage(bot.threadId, { role: "bot", kind: "options", at: NOW - 60_000, card: { title: "Which list?", subtitle: "", options: ["A", "B"], requestType: "question", requestId: "q1" } });
  store.appendMessage(bot.threadId, { role: "bot", kind: "activity", at: NOW - 30_000, tool: { name: "error: Invalid API key · Please run /login", ok: false, setup: true } });
  const route = createTodayRoutes({
    visibleFor: () => new VisibleSet(store.bots, store.groups, SEES_EVERYTHING),
    sources: () => ({ bots: store.bots, groups: store.groups, routines: null, engines: [], parked: [] }),
    now: () => NOW,
  });
  const call = async (method: string, target: string, scopes: RequestAuth["scopes"] = ["admin", "client"]) => {
    const sent: { status?: number; body?: any } = {};
    const url = new URL(target, "http://127.0.0.1");
    const out = await route({
      req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method,
      auth: { kind: "loopback", scopes }, readBody: (async () => ({})) as RouteContext["readBody"],
      json: ((_res: ServerResponse, status: number, body: unknown) => { sent.status = status; sent.body = body; }) as RouteContext["json"],
    });
    return { out, ...sent };
  };
  return { call };
}

describe("GET /api/today", () => {
  it("answers with the report for the window it is given", async () => {
    const { call } = setup();
    const { status, body } = await call("GET", `/api/today?since=${NOW - 3_600_000}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ since: NOW - 3_600_000, until: NOW, tiles: [], minutesSaved: 0, routineCount: 0 });
    expect(body.lines).toEqual([expect.objectContaining({ ok: false, error: "Invalid API key · Please run /login" })]);
    expect(body.needsYou.map((item: { kind: string }) => item.kind)).toEqual(["signed-out", "question"]);
  });

  it("refuses a missing window and other methods, and leaves other paths alone", async () => {
    const { call } = setup();
    expect((await call("GET", "/api/today")).status).toBe(400);
    expect((await call("GET", "/api/today?since=soon")).status).toBe(400);
    expect((await call("POST", `/api/today?since=${NOW}`)).status).toBe(405);
    expect((await call("GET", "/api/todays")).out).toBe(PASS);
  });

  it("gives engine and app fixes only to an admin, and opens the read to a paired client", async () => {
    const { call } = setup();
    const admin = await call("GET", `/api/today?since=${NOW - 3_600_000}`);
    expect(admin.body.needsYou.map((item: { kind: string }) => item.kind)).toEqual(["signed-out", "question"]);
    expect((await call("GET", `/api/today?since=${NOW - 3_600_000}`, ["client"])).body.needsYou.map((item: { kind: string }) => item.kind)).toEqual(["question"]);
    expect(requiredScope("GET", "/api/today")).toBe("client");
    expect(requiredScope("POST", "/api/today")).toBe("admin");
  });
});
