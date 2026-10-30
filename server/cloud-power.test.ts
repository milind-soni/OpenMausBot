import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { cloudRequestSignature } from "./cloud-home.ts";
import {
  CLOUD_IDLE_ACTIVITY_MS, CLOUD_IDLE_AWAKE_MS, CLOUD_IDLE_WORK_MS, CLOUD_POWER_PATH, CLOUD_POWER_SLEEP_PATH, CLOUD_SLEEP_PENDING_MS,
  countsAsActivity, createCloudPower, wakeCode, wokeFromSleep, WOKE_BY_MS, type CloudPowerProbes,
} from "./cloud-power.ts";
import { createCloudSignedRoutes } from "./routes/cloud-signed.ts";
import { SessionRegistry } from "./sessions.ts";

const START = 1_800_000_000_000;
const secret = "S".repeat(43);
const dirs: string[] = [];
const powers: { close(): void }[] = [];
afterEach(() => {
  for (const power of powers.splice(0)) power.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home(probes: Partial<CloudPowerProbes> = {}) {
  let clock = START;
  const dataDir = mkdtempSync(join(tmpdir(), "omb-cloud-power-"));
  dirs.push(dataDir);
  const state = { turn: false, run: false, liveCall: false, computer: false, maintenance: false, nextDueAt: null as number | null };
  const sent: Record<string, unknown>[] = [];
  const power = createCloudPower({ dataDir, now: () => clock, broadcast: (payload) => sent.push(payload), probes: {
    turn: () => state.turn, run: () => state.run, liveCall: () => state.liveCall, computer: () => state.computer,
    maintenance: () => state.maintenance, nextDueAt: () => state.nextDueAt, ...probes,
  } });
  powers.push(power);
  /** Moves the clock in ticks, as the 5-second timer would (a single big step is a resume). */
  const pass = (ms: number) => { for (let left = ms; left > 0; left -= 5_000) { clock += Math.min(5_000, left); power.tick(); } };
  return { power, state, sent, dataDir, pass, jump: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("the home's idle verdict", () => {
  it("is busy just after it wakes, then idle with nothing going on", () => {
    const h = home();
    expect(h.power.report()).toMatchObject({ v: 1, idle: false, busy: ["just-woke"], bootedAt: START, wokeAt: START, sleeping: false });
    h.pass(CLOUD_IDLE_AWAKE_MS);
    expect(h.power.report()).toMatchObject({ idle: true, busy: [] });
  });

  it("names every kind of work that keeps it awake", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    Object.assign(h.state, { turn: true, run: true, liveCall: true, computer: true, maintenance: true });
    expect(h.power.report().busy).toEqual(["turn", "run", "live-call", "computer", "maintenance"]);
  });

  it("stays awake two minutes after work ends, ten after someone used it", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.state.run = true;
    h.pass(5_000);
    h.state.run = false;
    expect(h.power.report().busy).toEqual(["recent-work"]);
    h.pass(CLOUD_IDLE_WORK_MS);
    expect(h.power.report().idle).toBe(true);
    h.power.noteActivity();
    expect(h.power.report().busy).toEqual(["recent-activity"]);
    h.pass(CLOUD_IDLE_ACTIVITY_MS - 5_000);
    expect(h.power.report().busy).toEqual(["recent-activity"]);
    expect(h.power.report(60_000).idle).toBe(true);
    h.pass(5_000);
    expect(h.power.report().idle).toBe(true);
  });

  it("keeps awake for a run due within five minutes and reports the next one", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.state.nextDueAt = h.now() + 4 * 60_000;
    expect(h.power.report()).toMatchObject({ busy: ["due-soon"], nextDueAt: h.now() + 4 * 60_000 });
    h.state.nextDueAt = h.now() + 6 * 60_000;
    expect(h.power.report()).toMatchObject({ idle: true, nextDueAt: h.now() + 6 * 60_000 });
  });

  it("counts a request in progress, but not a held poll or the event stream", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    const done = h.power.begin("/api/sync/folders/f1/uploads");
    expect(h.power.begin("/api/sync/changes")).toBeTypeOf("function");
    h.power.begin("/api/events");
    h.power.begin("/api/shared-computers/abc/poll");
    // A lent computer's device link stays open by design, like its poll: it never keeps the home awake.
    h.power.begin("/api/shared-computers/abc/link");
    expect(h.power.report().busy).toEqual(["maintenance"]);
    done(); done();
    expect(h.power.report().busy).toEqual(["recent-work"]);
  });
});

describe("the sleep handshake", () => {
  it("says no while busy, and yes when idle: tells clients, marks the volume and aborts held polls", () => {
    const h = home();
    expect(h.power.prepareSleep()).toEqual({ ok: false, busy: ["just-woke"] });
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.state.nextDueAt = h.now() + 60 * 60_000;
    const held = h.power.sleepSignal();
    expect(h.power.prepareSleep()).toEqual({ ok: true, nextDueAt: h.now() + 60 * 60_000 });
    expect(held.aborted).toBe(true);
    expect(h.sent).toEqual([{ kind: "power", state: "sleeping" }]);
    expect(h.power.sleeping()).toBe(true);
    expect(existsSync(join(h.dataDir, "cloud-sleep.json"))).toBe(true);
    expect(h.power.report().sleeping).toBe(true);
  });

  it("ends when someone uses the home, keeping the next sleep's signal fresh", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.prepareSleep();
    h.power.noteActivity();
    expect(h.power.sleeping()).toBe(false);
    expect(h.power.sleepSignal().aborted).toBe(false);
    expect(existsSync(join(h.dataDir, "cloud-sleep.json"))).toBe(false);
  });

  it("ends on a resume (the clock jumps), which also counts as waking", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.prepareSleep();
    h.jump(3 * 60 * 60_000);
    h.power.tick();
    expect(h.power.sleeping()).toBe(false);
    expect(h.power.report()).toMatchObject({ wokeAt: h.now(), busy: ["just-woke"] });
    expect(existsSync(join(h.dataDir, "cloud-sleep.json"))).toBe(false);
  });

  it("ends by itself when the Admin never carried it out", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.prepareSleep();
    h.pass(CLOUD_SLEEP_PENDING_MS);
    expect(h.power.sleeping()).toBe(false);
  });
});

describe("what woke the home", () => {
  it("is the first request after a boot or a resume, its kind and whether it was a background one, never more of it", () => {
    const h = home();
    expect(h.power.report().wokeBy).toBeNull();
    h.power.arrived("/api/events", {});
    h.power.arrived("/api/bots", {});
    expect(h.power.report().wokeBy).toEqual({ by: "events", background: true });
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.prepareSleep();
    // Suspended, then resumed for a request: noticed by the request itself, before the clock tick does.
    h.jump(33_000);
    h.power.arrived("/.well-known/openmausbot/environment", { "x-omb-background": "1" });
    expect(h.power.sleeping()).toBe(false);
    expect(h.power.report()).toMatchObject({ wokeAt: h.now(), wokeBy: { by: "version", background: true } });
    h.power.arrived("/api/threads", {});
    expect(h.power.report().wokeBy, "only the first one").toEqual({ by: "version", background: true });
    // Resumed, and nothing reached it for a while: whatever comes later did not wake it.
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.jump(3600_000);
    h.power.tick();
    h.pass(WOKE_BY_MS + 5_000);
    h.power.arrived("/api/bots", {});
    expect(h.power.report().wokeBy).toBeNull();
  });

  it("names each kind of request by its path alone", () => {
    const paths = ["/api/events", "/api/sync/changes", "/api/shared-computers/abc/poll", "/.well-known/openmausbot/environment", "/api/phones/self/jobs",
      "/api/presence/active", "/api/auth/session", "/api/auth/pair", "/pair", "/api/cloud/pairing", "/api/health", "/hooks", "/mcp-oauth/callback",
      "/api/bots/b1/read", "/", "/assets/index.js"];
    expect(paths.map(wakeCode)).toEqual(["events", "sync", "lending", "version", "phone", "presence", "session", "pair", "pair", "admin", "health", "webhook",
      "sign-in", "api", "page", "page"]);
  });
});

describe("waking from a sleep the machine was stopped for", () => {
  it("is not a startup once, and only after a sleep", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-cloud-power-"));
    dirs.push(dataDir);
    expect(wokeFromSleep(dataDir)).toBe(false);
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "cloud-sleep.json"), JSON.stringify({ at: START }));
    expect(wokeFromSleep(dataDir)).toBe(true);
    expect(wokeFromSleep(dataDir)).toBe(false);
  });

  it("leaves the marker for the next boot when the stop came while asleep", () => {
    const h = home();
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.prepareSleep();
    expect(JSON.parse(readFileSync(join(h.dataDir, "cloud-sleep.json"), "utf8"))).toEqual({ at: h.now() });
    expect(wokeFromSleep(h.dataDir)).toBe(true);
  });
});

describe("what counts as someone using the home", () => {
  it("is any request but the background paths and marked polls", () => {
    expect(countsAsActivity("/api/threads/t1", {})).toBe(true);
    expect(countsAsActivity("/api/threads/t1", { "x-omb-background": "0" })).toBe(true);
    expect(countsAsActivity("/api/team-map", { "x-omb-background": "1" })).toBe(false);
    for (const path of ["/api/events", "/api/health", "/api/sync", "/api/sync/changes", "/api/shared-computers/c1/poll", "/api/cloud/power"]) {
      expect(countsAsActivity(path, {}), path).toBe(false);
    }
    expect(countsAsActivity("/api/synchronize", {})).toBe(true);
  });
});

describe("the Admin's signed power routes", () => {
  function routes(h: ReturnType<typeof home>) {
    const sessions = new SessionRegistry({ file: join(h.dataDir, "sessions.json"), now: h.now });
    const health = { report: () => ({}) } as never;
    const handle = createCloudSignedRoutes({ secret, sessions, health, power: () => h.power, now: h.now });
    let counter = 0;
    const sign = (target: string, method = "GET", body = "", key = secret) => {
      const timestamp = String(Math.floor(h.now() / 1000)), nonce = `nonce-${String(++counter).padStart(12, "0")}`;
      return { "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudRequestSignature(key, timestamp, nonce, method, target, body)}` };
    };
    const send = async (method: string, target: string, headers: Record<string, string>, body = "") => {
      const req = Object.assign(new PassThrough(), { method, url: target, headers, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
      let status = 0, text = "";
      const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(data: string) { text = data; } } as unknown as ServerResponse;
      const url = new URL(target, "http://localhost");
      const answered = handle({ req, res, url, path: url.pathname, method });
      (req as unknown as PassThrough).end(body);
      expect(await answered).toBe(true);
      return { status, body: JSON.parse(text) };
    };
    return { sign, send };
  }

  it("reads the verdict, with the Admin's activity window", async () => {
    const h = home();
    const { sign, send } = routes(h);
    h.pass(CLOUD_IDLE_AWAKE_MS);
    h.power.noteActivity();
    h.pass(5 * 60_000);
    expect((await send("GET", CLOUD_POWER_PATH, sign(CLOUD_POWER_PATH))).body).toMatchObject({ v: 1, idle: false, busy: ["recent-activity"] });
    const target = `${CLOUD_POWER_PATH}?idleMinutes=5`;
    expect((await send("GET", target, sign(target))).body).toMatchObject({ idle: true });
  });

  it("refuses an unsigned or replayed read, and a wrong method", async () => {
    const h = home();
    const { sign, send } = routes(h);
    expect((await send("GET", CLOUD_POWER_PATH, sign(CLOUD_POWER_PATH, "GET", "", "K".repeat(43)))).status).toBe(401);
    const headers = sign(CLOUD_POWER_PATH);
    expect((await send("GET", CLOUD_POWER_PATH, headers)).status).toBe(200);
    expect((await send("GET", CLOUD_POWER_PATH, headers)).body).toEqual({ error: "replayed_request" });
    expect((await send("POST", CLOUD_POWER_PATH, sign(CLOUD_POWER_PATH, "POST"))).status).toBe(405);
  });

  it("answers a sleep request 409 while busy and 200 once idle, over a signed JSON body", async () => {
    const h = home();
    const { sign, send } = routes(h);
    const body = JSON.stringify({ v: 1, idleMinutes: 10 });
    const json = (extra: Record<string, string>) => ({ ...extra, "content-type": "application/json" });
    expect(await send("POST", CLOUD_POWER_SLEEP_PATH, json(sign(CLOUD_POWER_SLEEP_PATH, "POST", body)), body)).toEqual({ status: 409, body: { ok: false, busy: ["just-woke"] } });
    h.pass(CLOUD_IDLE_AWAKE_MS);
    expect(await send("POST", CLOUD_POWER_SLEEP_PATH, json(sign(CLOUD_POWER_SLEEP_PATH, "POST", body)), body)).toEqual({ status: 200, body: { ok: true, nextDueAt: null } });
    expect(h.power.sleeping()).toBe(true);
    expect((await send("POST", CLOUD_POWER_SLEEP_PATH, sign(CLOUD_POWER_SLEEP_PATH, "POST", body), body)).status).toBe(415);
    const bad = JSON.stringify({ v: 1, idleMinutes: 0 });
    expect((await send("POST", CLOUD_POWER_SLEEP_PATH, json(sign(CLOUD_POWER_SLEEP_PATH, "POST", bad)), bad)).body).toEqual({ error: "invalid_idle_minutes" });
    expect((await send("POST", CLOUD_POWER_SLEEP_PATH, json(sign(CLOUD_POWER_SLEEP_PATH, "POST", "{}")), body)).status).toBe(401);
  });

  it("is not a route on a server without power (every route but these answers as before)", async () => {
    const h = home();
    const sessions = new SessionRegistry({ file: join(h.dataDir, "sessions.json"), now: h.now });
    const handle = createCloudSignedRoutes({ secret, sessions, health: { report: () => ({}) } as never, now: h.now });
    const url = new URL(CLOUD_POWER_PATH, "http://localhost");
    const req = Object.assign(new PassThrough(), { method: "GET", url: CLOUD_POWER_PATH, headers: {}, socket: { remoteAddress: "127.0.0.1" } }) as unknown as IncomingMessage;
    expect(await handle({ req, res: {} as ServerResponse, url, path: url.pathname, method: "GET" })).toBe(false);
  });
});

describe("a Team Cloud", () => {
  it("never sleeps: the Admin's sleep request is refused as busy with the team, however idle it is", () => {
    let clock = START;
    const dataDir = mkdtempSync(join(tmpdir(), "omb-cloud-power-team-"));
    dirs.push(dataDir);
    const power = createCloudPower({ dataDir, team: true, now: () => clock, broadcast: () => {}, probes: {
      turn: () => false, run: () => false, liveCall: () => false, computer: () => false, maintenance: () => false, nextDueAt: () => null,
    } });
    powers.push(power);
    for (let left = CLOUD_IDLE_AWAKE_MS; left > 0; left -= 5_000) { clock += 5_000; power.tick(); }
    expect(power.report()).toMatchObject({ idle: true, busy: [] });
    expect(power.prepareSleep()).toEqual({ ok: false, busy: ["team"] });
    expect(power.sleeping()).toBe(false);
    expect(existsSync(join(dataDir, "cloud-sleep.json"))).toBe(false);
  });
});
