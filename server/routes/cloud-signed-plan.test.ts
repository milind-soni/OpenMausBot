import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { CLOUD_PLAN_PATH, createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43);

function routes(withPlan = true) {
  let counter = 0;
  const now = () => 1_800_000_000_000;
  const told: boolean[] = [];
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), now,
  });
  const handle = createCloudSignedRoutes({ secret, sessions, health, now, ...(withPlan ? { plan: (cancelled: boolean) => { told.push(cancelled); } } : {}) });
  const sign = (body: string, key = secret, method = "POST") => {
    const timestamp = String(Math.floor(now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, method, CLOUD_PLAN_PATH, body)}` };
  };
  const send = async (method: string, headers: Record<string, string>, body: string) => {
    const req = Object.assign(new PassThrough(), { method, url: CLOUD_PLAN_PATH, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
    const url = new URL(CLOUD_PLAN_PATH, "http://localhost");
    const answered = handle({ req, res, url, path: url.pathname, method });
    (req as unknown as PassThrough).end(body);
    return { answered: await answered, status, body: text ? JSON.parse(text) : null };
  };
  return { sign, send, told };
}

describe("POST /api/cloud/plan", () => {
  it("takes the Admin's signed word that the plan was cancelled, or renews again", async () => {
    const { sign, send, told } = routes();
    const cancelled = JSON.stringify({ v: 1, cancelled: true });
    expect(await send("POST", sign(cancelled), cancelled)).toEqual({ answered: true, status: 200, body: { ok: true } });
    const renewing = JSON.stringify({ v: 1, cancelled: false });
    expect((await send("POST", sign(renewing), renewing)).status).toBe(200);
    expect(told).toEqual([true, false]);
  });

  it("refuses a wrong key, a replay, a body that says neither, and anything but POST; changes nothing", async () => {
    const { sign, send, told } = routes();
    const body = JSON.stringify({ v: 1, cancelled: true });
    expect((await send("POST", sign(body, "W".repeat(43)), body)).status).toBe(401);
    const once = sign(body);
    expect((await send("POST", once, body)).status).toBe(200);
    expect((await send("POST", once, body)).body).toEqual({ error: "replayed_request" });
    const vague = JSON.stringify({ v: 1, cancelled: "yes" });
    expect((await send("POST", sign(vague), vague)).body).toEqual({ error: "invalid_plan" });
    expect((await send("GET", sign("", secret, "GET"), "")).status).toBe(405);
    expect(told).toEqual([true]);
  });

  it("is not a route on a server with no routines to hold", async () => {
    const { sign, send } = routes(false);
    const body = JSON.stringify({ v: 1, cancelled: true });
    expect((await send("POST", sign(body), body)).answered).toBe(false);
  });
});
