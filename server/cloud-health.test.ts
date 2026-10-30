import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { failedTurnTool } from "../shared/failed-turn.ts";
import type { PlaceRow } from "../shared/place-view.ts";
import { TRIAL_CREDIT_REFUSED } from "../shared/trial-credit.ts";
import { CLOUD_HEALTH_PATH, CLOUD_PAIRING_PATH, CLOUD_PAIRING_SKEW_S, cloudPairingSignature, cloudRequestSignature } from "./cloud-home.ts";
import { CLOUD_HEALTH_MAX_BYTES, HEALTH_BUCKET_CAP, createCloudHealth, createCloudHealthLedger, type CloudHealthDeps } from "./cloud-health.ts";
import { DATA_DIR, EVENTS_DIR } from "./config.ts";
import { memoryStallText, memoryStopText } from "./engine-memory.ts";
import type { RuntimeEvent } from "./contracts.ts";
import { createCloudSignedRoutes } from "./routes/cloud-signed.ts";
import { SessionRegistry } from "./sessions.ts";
import { Store } from "./store.ts";

const START = 1_800_000_000_000;
const secret = "S".repeat(43);

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(EVENTS_DIR, { recursive: true });
});

/** A real store and the bus as the server wires them; the clock and every slow lookup are the test's. */
function world(overrides: Partial<CloudHealthDeps> = {}) {
  let clock = START;
  const now = () => clock;
  const store = new Store(() => ({ instanceId: "claude", model: "claude-sonnet-5" }));
  const listeners = new Set<(event: RuntimeEvent) => void>();
  const bus = { subscribe: (listener: (event: RuntimeEvent) => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const health = createCloudHealth({
    store, bus, dataDir: DATA_DIR, eventsDir: EVENTS_DIR, version: "0.1.120", image: `registry.fly.io/omb-cloud-home@sha256:${"b".repeat(64)}`,
    engines: () => [{ instanceId: "claude", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: true, version: "2.1.300" } }],
    connectors: () => null, browser: () => ({ available: true, installing: false, interrupted: 0 }), now, ...overrides,
  });
  const bot = store.createBot({ name: "Tallyspoon Ops" });
  const emit = (threadId: string, event: { type: string } & Record<string, unknown>, provider = "codex") => {
    for (const listener of listeners) listener({ eventId: randomBytes(4).toString("hex"), provider, threadId, createdAt: new Date(clock).toISOString(), turnId: "t1", ...event } as RuntimeEvent);
  };
  const fail = (cause: string, flags: Parameters<typeof failedTurnTool>[1] = {}, threadId = bot.threadId) =>
    store.appendMessage(threadId, { role: "bot", kind: "activity", at: clock, tool: failedTurnTool(cause, flags) });
  return { store, bot, health, emit, fail, advance: (ms: number) => { clock += ms; }, now };
}

const incidents = (w: ReturnType<typeof world>, after?: string) => w.health.report(after).incidents.map(({ kind, code, engine, count }) => ({ kind, code, engine, count }));
const place = (state: PlaceRow["state"]): PlaceRow => ({ state, params: { bot: "Tallyspoon Ops", cause: "Boat said: quota exceeded for ada@example.test." }, source: "works-on" });

describe("a new Cloud's first hour in its health report", () => {
  it("carries the milestones and the Chief's counts, and null where there are none", () => {
    expect(world().health.report(undefined)).toMatchObject({ firstHour: null, value: null });
    const firstHour = { startedAt: START, ms: { firstMessage: 40_000, firstApp: 95_000 }, apps: ["gmail" as const] };
    const value = { sorted: 3, drafted: 1, prepped: 0, routines: 0, minutes: 8 };
    expect(world({ firstHour: () => ({ firstHour, value }) }).health.report(undefined)).toMatchObject({ firstHour, value });
  });
});

describe("the failure code a Cloud home reports", () => {
  it("names a place that could not be used by its state", () => {
    const w = world();
    w.fail("Your cloud computer hours are used up.", { place: place("cc-no-hours") });
    w.fail("Tallyspoon Ops' browser stopped.", { place: place("browser-cannot") });
    expect(incidents(w)).toEqual([{ kind: "place", code: "cc-no-hours", engine: null, count: 1 }, { kind: "place", code: "browser-cannot", engine: null, count: 1 }]);
  });

  it("takes the engine's stop reason, unless it is generic and the cause says more", () => {
    const w = world();
    const started = (threadId: string, provider = "codex") => w.emit(threadId, { type: "turn.started" }, provider);
    const threads = ["a", "b", "c", "d", "e"].map((title) => w.store.createTask(w.bot.id, title)!.threadId);
    started(threads[0]!);
    w.fail("codex app-server exited with signal 9", {}, threads[0]);
    w.emit(threads[0]!, { type: "turn.completed", ok: false, stopReason: "rpc_error" });
    started(threads[1]!);
    w.fail("Your ChatGPT sign-in has expired (401 Unauthorized). Sign in again.", { setup: true }, threads[1]);
    w.emit(threads[1]!, { type: "turn.completed", ok: false, stopReason: "auth_required" });
    started(threads[2]!);
    w.fail("You've hit your usage limit. Try again at 3pm.", {}, threads[2]);
    w.emit(threads[2]!, { type: "turn.completed", ok: false, stopReason: "rpc_error" });
    started(threads[3]!, "claudeAgent");
    w.fail("Invalid API key · Please run /login", { setup: true }, threads[3]);
    w.emit(threads[3]!, { type: "turn.completed", ok: false, stopReason: "auth_required" }, "claudeAgent");
    // A turn the engine could not stop, with no failed row of its own.
    started(threads[4]!);
    w.emit(threads[4]!, { type: "turn.completed", ok: false, stopReason: "shutdown_timeout" });
    expect(incidents(w)).toEqual([
      { kind: "turn", code: "rpc_error", engine: "codex", count: 1 },
      { kind: "turn", code: "auth_required", engine: "codex", count: 1 },
      { kind: "turn", code: "quota", engine: "codex", count: 1 },
      { kind: "turn", code: "auth_required", engine: "claudeAgent", count: 1 },
      { kind: "turn", code: "shutdown_timeout", engine: "codex", count: 1 },
    ]);
  });

  it("files a row whose turn never reports a stop under its own class once it has waited", () => {
    const w = world();
    w.emit(w.bot.threadId, { type: "turn.started" });
    w.fail("401 Unauthorized: missing bearer");
    expect(incidents(w)).toEqual([]);
    w.advance(6_000);
    expect(incidents(w)).toEqual([{ kind: "turn", code: "auth", engine: "codex", count: 1 }]);
  });

  it("names the failures the server writes itself, and a trial credit's refusal", () => {
    const w = world();
    w.fail("no activity for 20 minutes — the turn was stopped");
    w.fail("turn interrupted — OpenMausBot restarted");
    w.fail("this thread could not start — the engine is not installed");
    w.fail("queued message could not start — the engine is not installed");
    w.fail(TRIAL_CREDIT_REFUSED.used_up);
    w.fail(`${memoryStopText(5)} (opencodeGo exited null before the prompt result)`);
    w.fail(memoryStallText("no activity for 20 minutes — the turn was stopped", 1));
    expect(incidents(w)).toEqual([
      { kind: "turn", code: "stalled", engine: null, count: 1 },
      { kind: "turn", code: "restart", engine: null, count: 1 },
      { kind: "turn", code: "could_not_start", engine: null, count: 2 },
      { kind: "turn", code: "trial_used_up", engine: null, count: 1 },
      { kind: "turn", code: "out_of_memory", engine: null, count: 2 },
    ]);
  });

  it("counts only failed-turn rows, and an engine stop that also wrote one counts once", () => {
    const w = world();
    w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "activity", tool: { name: "Bash", ok: false } });
    w.store.appendMessage(w.bot.threadId, { role: "bot", kind: "activity", tool: { name: "notice: retrying", ok: true } });
    w.store.appendMessage(w.bot.threadId, { role: "user", kind: "text", text: "error: this is what the person typed" });
    expect(incidents(w)).toEqual([]);
    w.emit(w.bot.threadId, { type: "turn.started" });
    w.fail("codex did not shut down after termination was requested");
    w.emit(w.bot.threadId, { type: "turn.completed", ok: false, stopReason: "shutdown_timeout" });
    w.emit(w.bot.threadId, { type: "turn.completed", ok: false, stopReason: "shutdown_timeout" });
    w.emit(w.bot.threadId, { type: "turn.completed", ok: false, stopReason: "interrupted" });
    expect(incidents(w)).toEqual([{ kind: "turn", code: "shutdown_timeout", engine: "codex", count: 1 }]);
  });
});

describe("the ledger", () => {
  it("dedupes by kind, code and engine, and a cursor reads only what changed since", () => {
    const w = world();
    for (let i = 0; i < 3; i++) { w.fail("turn interrupted — OpenMausBot restarted"); w.advance(60_000); }
    const first = w.health.report(null);
    expect(first.incidents).toEqual([expect.objectContaining({ code: "restart", count: 3, firstAt: START, lastAt: START + 120_000, botId: w.bot.id, threadId: w.bot.threadId })]);
    expect(w.health.report(first.cursor).incidents).toEqual([]);
    w.fail("this thread could not start — no engine");
    w.fail("turn interrupted — OpenMausBot restarted");
    const next = w.health.report(first.cursor);
    expect(next.incidents.map(({ code, count }) => ({ code, count }))).toEqual([{ code: "could_not_start", count: 1 }, { code: "restart", count: 4 }]);
    // Another boot's cursor, or one from the future, reads from the start.
    expect(w.health.report(`${START - 1}.1`).incidents).toHaveLength(2);
    expect(w.health.report(`${START}.999`).incidents).toHaveLength(2);
    expect(w.health.report("junk").incidents).toHaveLength(2);
  });

  it("keeps at most HEALTH_BUCKET_CAP buckets, dropping the one quiet the longest", () => {
    let clock = START;
    const ledger = createCloudHealthLedger({ now: () => clock });
    for (let i = 0; i <= HEALTH_BUCKET_CAP; i++) {
      ledger.noteEvent({ eventId: "e", provider: `engine${i}`, threadId: `thread-${i}`, createdAt: "", type: "turn.started" });
      ledger.noteMessage(`thread-${i}`, { at: clock, tool: failedTurnTool("turn interrupted — OpenMausBot restarted") });
      clock += 1000;
    }
    const read = ledger.read(null);
    expect(read.incidents).toHaveLength(HEALTH_BUCKET_CAP);
    expect(read.incidents.map((incident) => incident.engine)).not.toContain("engine0");
    expect(read.incidents.at(-1)!.engine).toBe(`engine${HEALTH_BUCKET_CAP}`);
  });

  it("rates turns over 15 minutes and a day", () => {
    const w = world();
    for (let i = 0; i < 4; i++) w.emit(w.bot.threadId, { type: "turn.started" });
    w.fail("turn interrupted — OpenMausBot restarted");
    w.advance(20 * 60_000);
    w.emit(w.bot.threadId, { type: "turn.started" });
    w.fail("no activity for 20 minutes — the turn was stopped");
    expect(w.health.report(null).turns).toEqual({ started15m: 1, failed15m: 1, started24h: 5, failed24h: 2 });
    w.advance(24 * 3600_000);
    expect(w.health.report(null).turns).toEqual({ started15m: 0, failed15m: 0, started24h: 0, failed24h: 0 });
  });

  it("follows each routine's last outcome and its failures in a row", () => {
    const w = world();
    const run = (id: string, status: "completed" | "failed" | "missed" | "running") => w.health.noteRoutineRun({ id, routineId: "routine-1", status, finishedAt: w.now() });
    run("r1", "failed"); run("r1", "failed"); run("r2", "running"); run("r2", "missed");
    expect(w.health.report(null).routines).toEqual([{ routineId: "routine-1", status: "missed", at: START, consecutiveFailures: 2 }]);
    run("r3", "completed");
    expect(w.health.report(null).routines).toEqual([{ routineId: "routine-1", status: "completed", at: START, consecutiveFailures: 0 }]);
  });
});

describe("the report", () => {
  it("never carries a failure's words, a name, a title, a prompt, an address, a URL or an engine's account", async () => {
    const planted = ["Tallyspoon Ops", "Secret Merger Plans", "ada.lovelace@example.test", "Quarterly numbers for ACME", "https://intranet.acme.test/q3",
      "Draft the ACME layoffs memo", "owner@example.test", "Ada Org", "acct-7f3a-secret", "sk-ant-api03-planted", "Boat said: quota exceeded"];
    const w = world({
      engines: () => [{ instanceId: "claude", driverKind: "claudeAgent",
        snapshot: { state: "available", authenticated: false, version: "2.1.300", reason: "Quarterly numbers for ACME", account: { email: "owner@example.test", organization: "Ada Org", method: "login" } } }],
      connectors: () => Promise.resolve({ gmail: { connected: true, accounts: [{ id: "acct-7f3a-secret", alias: "ada.lovelace@example.test" }] }, notion: { connected: false },
        "https://intranet.acme.test/q3": { connected: false } }),
    });
    const task = w.store.createTask(w.bot.id, "Secret Merger Plans")!;
    w.store.appendMessage(task.threadId, { role: "user", kind: "text", text: "Draft the ACME layoffs memo" });
    w.emit(task.threadId, { type: "turn.started" });
    w.fail("Quarterly numbers for ACME failed for ada.lovelace@example.test at https://intranet.acme.test/q3 (sk-ant-api03-planted)", {}, task.threadId);
    w.emit(task.threadId, { type: "turn.completed", ok: false, stopReason: "Quarterly numbers for ACME" });
    w.fail("Boat said: quota exceeded", { place: place("cc-provider") }, task.threadId);
    w.health.report(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const body = JSON.stringify(w.health.report(null));
    for (const words of planted) expect(body, words).not.toContain(words);
    const report = JSON.parse(body);
    expect(report.incidents.map((incident: { code: string }) => incident.code)).toEqual(["unknown", "cc-provider"]);
    expect(report.engines).toEqual([{ kind: "claudeAgent", used: true, available: true, authenticated: false, version: "2.1.300" }]);
    expect(report.connectors.items).toEqual([{ slug: "gmail", connected: true }, { slug: "notion", connected: false }]);
  });

  it("answers at once and looks up connected apps in the background, at most every 30 minutes", async () => {
    let lookups = 0;
    let answer: (value: Record<string, { connected: boolean }>) => void = () => {};
    const w = world({ connectors: () => { lookups++; return new Promise((resolve) => { answer = resolve; }); } });
    expect(w.health.report(null).connectors).toBeNull();
    expect(w.health.report(null).connectors).toBeNull();
    expect(lookups).toBe(1);
    answer({ slack: { connected: false } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.health.report(null).connectors).toEqual({ checkedAt: START, failed: false, items: [{ slug: "slack", connected: false }] });
    w.advance(29 * 60_000);
    w.health.report(null);
    expect(lookups).toBe(1);
    w.advance(60_000);
    w.health.report(null);
    expect(lookups).toBe(2);
  });

  it("stays under 64 KB, and the cursor picks up what did not fit", () => {
    let clock = START;
    const routines = Array.from({ length: 100 }, (_, i) => `r${String(i).padStart(63, "0")}`);
    const w = world({ now: () => clock });
    for (const routineId of routines) w.health.noteRoutineRun({ id: routineId, routineId, status: "failed" });
    const ledger = w.health.ledger;
    for (let i = 0; i < HEALTH_BUCKET_CAP; i++) {
      const thread = `t${String(i).padStart(63, "0")}`;
      ledger.noteEvent({ eventId: "e", provider: `e${String(i).padStart(63, "0")}`, threadId: thread, createdAt: "", type: "turn.started" });
      ledger.noteMessage(thread, { at: clock, tool: failedTurnTool("cut off", { place: place("cc-on-my-cloud") }), from: { botId: `b${"0".repeat(63)}`, name: "x", color: "x" } });
      clock += 1;
    }
    const first = w.health.report(null);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(CLOUD_HEALTH_MAX_BYTES);
    expect(first.truncated).toBe(true);
    const rest = w.health.report(first.cursor);
    expect(rest.truncated).toBe(false);
    expect(first.incidents.length + rest.incidents.length).toBe(HEALTH_BUCKET_CAP);
    expect(new Set([...first.incidents, ...rest.incidents].map((incident) => incident.engine)).size).toBe(HEALTH_BUCKET_CAP);
  });
});

/** The route as the server runs it, before the session gate. */
function routes(w: ReturnType<typeof world>) {
  const sessions = new SessionRegistry({ file: join(DATA_DIR, "sessions.json"), now: w.now });
  const handle = createCloudSignedRoutes({ secret, sessions, health: w.health, now: w.now });
  let counter = 0;
  const sign = (target: string, options: { method?: string; key?: string; at?: number; nonce?: string; body?: string } = {}) => {
    const timestamp = String(Math.floor((options.at ?? w.now()) / 1000)), nonce = options.nonce ?? `nonce-${String(++counter).padStart(12, "0")}`;
    return { "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${cloudRequestSignature(options.key ?? secret, timestamp, nonce, options.method ?? "GET", target, options.body ?? "")}` };
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
  return { sessions, sign, send };
}

describe("GET /api/cloud/health", () => {
  it("answers the Admin's signed read with the report", async () => {
    const w = world();
    w.fail("turn interrupted — OpenMausBot restarted");
    const { sign, send } = routes(w);
    const target = `${CLOUD_HEALTH_PATH}?after=0`;
    const answer = await send("GET", target, sign(target));
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ v: 1, version: "0.1.120", bootedAt: START, incidents: [{ kind: "turn", code: "restart", count: 1 }] });
    const again = `${CLOUD_HEALTH_PATH}?after=${answer.body.cursor}`;
    expect((await send("GET", again, sign(again))).body.incidents).toEqual([]);
  });

  it("refuses a wrong key, another path or query, a stale or replayed request, and anything but GET", async () => {
    const w = world();
    const { sign, send } = routes(w);
    const target = `${CLOUD_HEALTH_PATH}?after=0`;
    expect(await send("GET", target, sign(target, { key: "W".repeat(43) }))).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await send("GET", target, sign(`${CLOUD_HEALTH_PATH}?after=5`))).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await send("GET", target, sign(CLOUD_PAIRING_PATH))).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await send("GET", target, sign(target, { method: "POST" }))).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await send("GET", target, {})).toEqual({ status: 401, body: { error: "invalid_signature" } });
    expect(await send("GET", target, sign(target, { at: w.now() - (CLOUD_PAIRING_SKEW_S + 1) * 1000 }))).toEqual({ status: 401, body: { error: "stale_request" } });
    const once = sign(target);
    expect((await send("GET", target, once)).status).toBe(200);
    expect(await send("GET", target, once)).toEqual({ status: 401, body: { error: "replayed_request" } });
    expect(await send("POST", target, sign(target, { method: "POST" }))).toEqual({ status: 405, body: { error: "method_not_allowed" } });
  });

  it("never locks the Admin out of pairing, and a health signature never opens a pairing window", async () => {
    const w = world();
    const { sign, send, sessions } = routes(w);
    const target = `${CLOUD_HEALTH_PATH}?after=0`;
    for (let i = 0; i < 20; i++) expect((await send("GET", target, sign(target, { key: "W".repeat(43) }))).status).toBe(401);
    expect(sessions.failureSources()).toEqual([]);
    const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
    const healthSigned = sign(target);
    expect((await send("POST", CLOUD_PAIRING_PATH, { ...healthSigned, "content-type": "application/json" }, body)).status).toBe(401);
    const timestamp = String(Math.floor(w.now() / 1000)), nonce = "nonce-pairing-000001";
    const paired = await send("POST", CLOUD_PAIRING_PATH, { "content-type": "application/json", "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce,
      "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}` }, body);
    expect(paired.status).toBe(200);
    expect(paired.body.code).toMatch(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
  });
});
