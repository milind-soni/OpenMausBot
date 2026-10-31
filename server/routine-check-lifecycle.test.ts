import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createConnectedReads, type ConnectedReads } from "./connected-reads.ts";
import { createDecider } from "./decider/index.ts";
import { DECIDER_LOG_DIR, flushDeciderLog } from "./decider/log.ts";
import { createExtractor } from "./extractor/index.ts";
import { createInboxTriage } from "./host/inbox-triage.ts";
import { createRoutineChecks } from "./host/routine-checks.ts";
import { createMoveFreeze } from "./move-freeze.ts";
import { RoutineManager } from "./routines.ts";
import { WorkspaceBackupMaintenance } from "./workspace-backup-maintenance.ts";

const logWrite = vi.hoisted(() => ({ gate: undefined as undefined | { entered(): void; wait: Promise<void> } }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, appendFile: async (...args: Parameters<typeof fs.appendFile>) => {
    const gate = logWrite.gate;
    if (gate) { gate.entered(); await gate.wait; }
    return fs.appendFile(...args);
  } };
});

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); vi.useRealTimers(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-check-lifecycle-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, now: Date.parse("2026-10-29T09:00:00Z") };
}

it("accepts a production mail check with four successful 45-second reads", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dir, now } = fixture();
  let completed = 0, tasks = 0;
  const reads = createConnectedReads({
    connected: async () => ({ gmail: true, googlecalendar: false }),
    relay: async (payload, _session, signal) => {
      const request = payload as { method: string; params: { arguments: { tools: Array<{ tool_slug: string; arguments: { page_token?: string } }> } } };
      if (request.method === "initialize") return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: "synthetic" };
      if (request.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      const tool = request.params.arguments.tools[0]!;
      await new Promise<void>((resolve) => setTimeout(resolve, 45_000));
      signal.throwIfAborted(); completed++;
      const page = Number(tool.arguments.page_token ?? 1);
      const data = tool.tool_slug === "GMAIL_GET_PROFILE" ? { emailAddress: "owner@fixture.test" } : {
        messages: [{ messageId: `mail-${page}`, threadId: `thread-${page}`, messageTimestamp: "2026-10-29T08:59:00Z",
          sender: "Ada <ada@fixture.test>", subject: "Please review", snippet: "Please review this" }],
        ...(page < 3 ? { nextPageToken: String(page + 1) } : {}),
      };
      const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: tool.tool_slug, response: { successful: true, data } }] } });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "omb-check-call", result: { content: [{ type: "text", text }] } })) };
    },
  });
  const checks = createRoutineChecks({ dataDir: dir, reads, now: () => now, mayRead: () => true, fenced: () => true,
    timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() {} });
  const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, checks, botState: () => "ready",
    createTask: () => ({ threadId: `task-${++tasks}` }), startTurn: async () => {} });
  cleanups.push(() => manager.close());
  const routine = manager.create({ name: "Mail", prompt: "Check", botId: "bot", checks: ["mail"],
    schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 900_000 } });
  manager.runNow(routine.id); await manager.tick(); await drain();
  await vi.advanceTimersByTimeAsync(181_000); await drain(); await manager.tick(); await drain();
  expect(tasks).toBe(1);
  expect(completed).toBe(4);
  expect(manager.listRuns()[0]!.status).toBe("running");
});

it.each(["extraction", "decision"] as const)("cancels production triage during %s without later requests or log writes during backup", async (stage) => {
  const { dir, now } = fixture();
  const gate = deferred();
  const config = () => ({ decider: { enabled: true, workersAiToken: "synthetic_token", workersAiAccountId: "0123456789abcdef0123456789abcdef" } });
  const requests: Array<{ extraction: boolean; signal: AbortSignal }> = [];
  const fetchImpl: typeof fetch = async (_url, options) => {
    const extraction = typeof JSON.parse(String(options!.body)).state === "string";
    requests.push({ extraction, signal: options!.signal! });
    if (extraction === (stage === "extraction")) await gate.promise;
    return new Response("synthetic failure", { status: 503 });
  };
  const decider = createDecider({ config, dataDir: dir, fetch: fetchImpl });
  const triage = createInboxTriage({ config, decider, extractor: createExtractor({ config, fetch: fetchImpl }) });
  let pendingTriage: ReturnType<typeof triage.triage> | undefined;
  const inbox = { ...triage, triage(...args: Parameters<typeof triage.triage>) { pendingTriage = triage.triage(...args); return pendingTriage; } };
  const emails = Array.from({ length: 8 }, (_, i) => ({ id: `m${i}`, threadId: `t${i}`, at: now - 60_000,
    from: "Ada <ada@fixture.test>", subject: "Review needed", preview: "Please review" }));
  const reads: ConnectedReads = { connected: async () => ({ gmail: true, googlecalendar: false }), session: () => ({
    address: async () => "owner@fixture.test", emails: async () => ({ emails, more: false }), events: async () => [], message: async () => null, thread: async () => [],
  }) };
  const checks = createRoutineChecks({ dataDir: dir, reads, inbox, now: () => now, mayRead: () => true, fenced: () => true,
    timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() {} });
  const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, checks, botState: () => "ready",
    createTask: () => ({ threadId: "unexpected" }), startTurn: async () => {} });
  cleanups.push(() => manager.close());
  try {
    const routine = manager.create({ name: "Mail", prompt: "Check", botId: "bot", checks: ["mail"], deliver: "brief",
      schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 900_000 } });
    manager.runNow(routine.id); await manager.tick(); await drain();
    const before = requests.length;
    expect(before).toBe(stage === "extraction" ? 8 : 12);
    manager.stop(); await drain();
    expect(manager.isTicking).toBe(false);
    await new WorkspaceBackupMaintenance().run(async () => {
      gate.resolve(); await pendingTriage?.catch(() => undefined); await flushDeciderLog(dir);
      expect(requests).toHaveLength(before);
      expect(requests.every((request) => request.signal.aborted || (stage === "decision" && request.extraction))).toBe(true);
      const logDir = join(dir, DECIDER_LOG_DIR);
      const rows = existsSync(logDir) ? readdirSync(logDir).flatMap((file) => readFileSync(join(logDir, file), "utf8").trim().split("\n")) : [];
      expect(rows).toEqual([]);
      expect(checks.pendingKeys()).toEqual([]);
    }, { idle: () => !manager.isTicking, pause: () => manager.stop(), resume() {}, flush: async () => {} });
  } finally {
    gate.resolve(); await pendingTriage?.catch(() => undefined); await flushDeciderLog(dir);
  }
});

it("keeps backup admission closed until an in-flight decision-log write drains after stop", async () => {
  const { dir, now } = fixture();
  const entered = deferred(), written = deferred(), read = deferred();
  logWrite.gate = { entered: entered.resolve, wait: written.promise };
  const decider = createDecider({ dataDir: dir, config: () => ({ decider: { enabled: true, key: "synthetic_token" } }),
    fetch: async () => new Response("synthetic failure", { status: 503 }) });
  const reads: ConnectedReads = { connected: async () => { await read.promise; return null; }, session: () => { throw new Error("unexpected read"); } };
  const checks = createRoutineChecks({ dataDir: dir, reads, now: () => now, mayRead: () => true, fenced: () => true,
    timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() {} });
  const manager = new RoutineManager({ file: join(dir, "routines.json"), checks, now: () => now, botState: () => "ready",
    createTask: () => ({ threadId: "unexpected" }), startTurn: async () => {} });
  cleanups.push(() => manager.close());
  try {
    const routine = manager.create({ name: "Mail", prompt: "Check", botId: "bot", checks: ["mail"],
      schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 900_000 } });
    manager.runNow(routine.id); await manager.tick(); await drain();
    await decider.choose("inboxTriage", {}, { instructions: "Pick", options: { skip: "Skip", keep: "Keep" } });
    await entered.promise;
    manager.stop(); await drain();
    expect(manager.isTicking).toBe(true);
    const backup = new WorkspaceBackupMaintenance();
    const hooks = { idle: () => !manager.isTicking, pause: () => manager.stop(), resume() {}, flush: async () => {} };
    await expect(backup.run(async () => "backup", hooks)).rejects.toMatchObject({ status: 409 });
    written.resolve(); await flushDeciderLog(dir); await drain();
    expect(manager.isTicking).toBe(false);
    await expect(backup.run(async () => "backup", hooks)).resolves.toBe("backup");
  } finally {
    written.resolve(); read.resolve(); await flushDeciderLog(dir); logWrite.gate = undefined;
  }
});

it.each(["decision", "extraction"] as const)("does not start the %s transport when stopped before its first microtask", async (kind) => {
  const config = () => ({ decider: { enabled: true, workersAiToken: "synthetic_token", workersAiAccountId: "0123456789abcdef0123456789abcdef" } });
  const controller = new AbortController();
  let requests = 0;
  const fetchImpl: typeof fetch = async () => { requests++; return new Response("synthetic failure", { status: 503 }); };
  const pending = kind === "decision"
    ? createDecider({ config, fetch: fetchImpl }).choose("inboxTriage", {}, { instructions: "Pick", options: { skip: "Skip", keep: "Keep" } }, { signal: controller.signal })
    : createExtractor({ config, fetch: fetchImpl }).extract("inboxTriage", { sender: { type: "string" } }, { text: "Ada" }, { signal: controller.signal });
  controller.abort();
  await pending;
  expect(requests).toBe(0);
});

it.each((["address", "calendars", "events", "emails"] as const).flatMap((stage) =>
  (["stop", "freeze", "timeout"] as const).map((cancel) => ({ stage, cancel })),
))("aborts the in-flight $stage relay on $cancel", async ({ stage, cancel }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { dir, now } = fixture();
  const entered = deferred(), released = deferred();
  const requests: string[] = [];
  let inFlight: AbortSignal | undefined;
  let pendingRead: Promise<unknown> | undefined;
  const reads = createConnectedReads({
    connected: async () => ({ gmail: true, googlecalendar: true }),
    relay: async (payload, _session, signal) => {
      const request = payload as { method: string; params: { arguments: { tools: Array<{ tool_slug: string; arguments: { page_token?: string } }> } } };
      if (request.method === "initialize") return { status: 200, bytes: new TextEncoder().encode("{}"), transportSessionId: "synthetic" };
      if (request.method !== "tools/call") return { status: 202, bytes: new Uint8Array() };
      const tool = request.params.arguments.tools[0]!;
      requests.push(tool.tool_slug);
      const blocked = stage === "address" ? tool.tool_slug === "GMAIL_GET_PROFILE"
        : stage === "calendars" ? tool.tool_slug === "GOOGLECALENDAR_LIST_CALENDARS"
        : stage === "events" ? tool.tool_slug === "GOOGLECALENDAR_EVENTS_LIST"
        : tool.tool_slug === "GMAIL_FETCH_EMAILS" && tool.arguments.page_token === "2";
      if (blocked) {
        inFlight = signal; entered.resolve();
        pendingRead = new Promise<void>((resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          void released.promise.then(() => { signal.removeEventListener("abort", aborted); resolve(); });
        });
        await pendingRead;
      }
      const data = tool.tool_slug === "GMAIL_GET_PROFILE" ? { emailAddress: "owner@fixture.test" }
        : tool.tool_slug === "GOOGLECALENDAR_LIST_CALENDARS" ? { items: [{ id: "primary", primary: true }] }
        : tool.tool_slug === "GOOGLECALENDAR_EVENTS_LIST" ? { items: [] }
        : { messages: [], nextPageToken: String(Number(tool.arguments.page_token ?? 1) + 1) };
      const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: tool.tool_slug, response: { successful: true, data } }] } });
      return { status: 200, bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: "omb-check-call", result: { content: [{ type: "text", text }] } })) };
    },
  });
  const checks = createRoutineChecks({ dataDir: dir, reads, now: () => now, mayRead: () => true, fenced: () => true,
    timeZone: () => "UTC", runs: () => [], dismissedFrom: () => [], report() { throw new Error("late report"); } });
  const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, checks: { ...checks, timeoutMs: 100 }, botState: () => "ready",
    createTask: () => { throw new Error("late task"); }, startTurn: async () => {} });
  cleanups.push(() => manager.close());
  try {
    const routine = manager.create({ name: "Read", prompt: "Check", botId: "bot", checks: ["calendar", "mail"],
      schedule: { type: "interval", everyMinutes: 15, anchorAt: now + 900_000 } });
    manager.runNow(routine.id); await manager.tick(); await entered.promise;
    const before = requests.length;
    if (cancel === "timeout") await vi.advanceTimersByTimeAsync(101);
    else if (cancel === "stop") manager.stop();
    else {
      const freeze = createMoveFreeze({ dataDir: dir });
      freeze.hold(() => manager.start(), () => manager.stop());
      freeze.freeze("fixture-cloud");
    }
    await drain();
    expect(inFlight?.aborted, cancel).toBe(true);
    released.resolve(); await pendingRead?.catch(() => undefined); await drain();
    expect(requests, cancel).toHaveLength(before);
    expect(checks.pendingKeys()).toEqual([]);
    expect(manager.isTicking).toBe(false);
  } finally {
    released.resolve(); await pendingRead?.catch(() => undefined); await drain();
    manager.close();
  }
});
