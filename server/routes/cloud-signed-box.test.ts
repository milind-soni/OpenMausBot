import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import type { BoxReport } from "../bot-box/box.ts";
import { boxSummary, createCloudHealth } from "../cloud-health.ts";
import { cloudRequestSignature } from "../cloud-home.ts";
import { DATA_DIR } from "../config.ts";
import { SessionRegistry } from "../sessions.ts";
import { CLOUD_BOX_PATH, createCloudSignedRoutes } from "./cloud-signed.ts";

const secret = "S".repeat(43);
const broker = { on: true, tokens: 2, forwarded: 9, refused: 1, unbrokered: ["XAI_API_KEY"] };
const hardening = { seccomp: "on" as const, denied: 34, hidepid: true, flyApiPrivate: true };
const report: BoxReport = { box: "bwrap", reason: null, checks: { passed: 23, total: 23, failed: [], at: 5 }, bridge: "socat", boxed: 4, refused: { egress: 2, harness: 1 }, broker, hardening };

function routes(box?: () => BoxReport) {
  let clock = 1_800_000_000_000, counter = 0;
  const now = () => clock;
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now });
  const health = createCloudHealth({
    store: { onChange: () => () => {}, botByThread: () => null, bots: [] }, bus: { subscribe: () => () => {} },
    engines: () => [], dataDir: DATA_DIR, eventsDir: DATA_DIR, version: "0.1.0", image: undefined, connectors: () => null,
    browser: () => ({ available: true, installing: false, interrupted: 0 }), box, now,
  });
  const handle = createCloudSignedRoutes({ secret, sessions, health, box, now });
  const sign = (target: string, method = "GET", key = secret) => {
    const timestamp = String(Math.floor(now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
    return { "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, method, target, "")}` };
  };
  const send = async (method: string, target: string, headers: Record<string, string>) => {
    const req = Object.assign(new PassThrough(), { method, url: target, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    let status = 0, text = "";
    const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
    const url = new URL(target, "http://localhost");
    const answered = handle({ req, res, url, path: url.pathname, method });
    (req as unknown as PassThrough).end("");
    return { answered: await answered, status, body: text ? JSON.parse(text) : null };
  };
  return { sign, send, health, tick: () => { clock += 1000; } };
}

describe("GET /api/cloud/box", () => {
  it("answers the Admin's signed read with the box's kind and self-check count, and the health report carries the same", async () => {
    const { sign, send, health } = routes(() => report);
    const answer = await send("GET", CLOUD_BOX_PATH, sign(CLOUD_BOX_PATH));
    expect(answer.answered).toBe(true);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ v: 1, at: 1_800_000_000_000, box: "bwrap", reason: null, checks: "23/23", failed: [], boxed: 4, refused: { egress: 2, harness: 1 }, broker, hardening });
    expect(health.report(null).box).toEqual({ box: "bwrap", reason: null, checks: "23/23", failed: [], boxed: 4, refused: { egress: 2, harness: 1 }, broker, hardening });
  });

  it("says off, with the reason, on a server with no box", async () => {
    const off = { on: false, tokens: 0, forwarded: 0, refused: 0, unbrokered: [] };
    const { sign, send, health } = routes(() => ({ box: "off", reason: "userns-refused", checks: null, bridge: null, boxed: 0, refused: { egress: 0, harness: 0 }, broker: off, hardening: { seccomp: "off", denied: 0, hidepid: false, flyApiPrivate: true } }));
    expect((await send("GET", CLOUD_BOX_PATH, sign(CLOUD_BOX_PATH))).body).toMatchObject({ box: "off", reason: "userns-refused", checks: null });
    expect(health.report(null).box).toMatchObject({ box: "off", reason: "userns-refused" });
    const none = routes();
    expect((await none.send("GET", CLOUD_BOX_PATH, none.sign(CLOUD_BOX_PATH))).body).toMatchObject({ box: "off", reason: "not-cloud" });
    expect(none.health.report(null).box).toBeNull();
  });

  it("refuses a wrong key, a replay and anything but GET", async () => {
    const { sign, send } = routes(() => report);
    expect((await send("GET", CLOUD_BOX_PATH, sign(CLOUD_BOX_PATH, "GET", "W".repeat(43)))).status).toBe(401);
    expect((await send("GET", CLOUD_BOX_PATH, {})).status).toBe(401);
    const once = sign(CLOUD_BOX_PATH);
    expect((await send("GET", CLOUD_BOX_PATH, once)).status).toBe(200);
    expect((await send("GET", CLOUD_BOX_PATH, once)).body).toEqual({ error: "replayed_request" });
    expect((await send("POST", CLOUD_BOX_PATH, sign(CLOUD_BOX_PATH, "POST"))).status).toBe(405);
  });

  it("carries only fixed codes: a failed check id or an unbrokered name that is not one is left out", () => {
    const summary = boxSummary({ ...report, checks: { passed: 1, total: 3, failed: ["egress-public-allowed", "a bot's name!"], at: 1 }, broker: { ...broker, unbrokered: ["XAI_API_KEY", "not a name!"] } });
    expect(summary?.failed).toEqual(["egress-public-allowed"]);
    expect(summary?.broker.unbrokered).toEqual(["XAI_API_KEY"]);
    expect(summary?.checks).toBe("1/3");
    expect(boxSummary(undefined)).toBeNull();
  });
});
