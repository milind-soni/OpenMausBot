import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineLimitsReport } from "../../shared/limit-reset.ts";
import { createCloudHealth } from "../cloud-health.ts";
import type { RuntimeEvent } from "../contracts.ts";
import { buildDevsReport } from "../devs-report.ts";
import type { StoreChange } from "../store.ts";
import { createPerfHost, PERF_FILE } from "./perf-host.ts";
import { PERF_HEALTH_MAX_BYTES, perfHealth } from "./perf-report.ts";
import { createProcessSampler, type ProcessList } from "./process-sampler.ts";
import { createTurnTimings } from "./turn-timings.ts";

const START = 1_800_000_000_000;
const SECRETS = [
  "sk-ant-api03-PRIVATEPRIVATEPRIVATE1234567890", "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "hunter2-password", "ada@example.test",
  "/Users/ada/Projects/acme-merger/plan.md", "acme-merger", "https://intranet.acme.test/q?token=abc", "intranet.acme.test",
  "Summarize the merger plan", "acme-internal", "Tallyspoon", "OMB_SECRET_VALUE_42", "lookup_customer", "Ada's Claude",
];
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function seeded() {
  let clock = START, mono = 0;
  const dir = mkdtempSync(join(tmpdir(), "perf-privacy-"));
  dirs.push(dir);
  const busListeners = new Set<(event: RuntimeEvent) => void>(), storeListeners = new Set<(change: StoreChange) => void>();
  const logged: string[] = [];
  const lists: ProcessList[] = [];
  const procRows = (cpu: number) => [
    { pid: 100, ppid: 1, name: "node", cpuMs: cpu, rssBytes: 1e8, start: "a" },
    { pid: 200, ppid: 100, name: "claude", cpuMs: cpu * 2, rssBytes: 3e8, start: "b" },
    { pid: 201, ppid: 200, name: "/users/ada/projects/acme-merger/bin/sk-ant-api03-privateprivateprivate1234567890", cpuMs: cpu, rssBytes: 1e7, start: "c" },
    { pid: 202, ppid: 200, name: "https://intranet.acme.test/q?token=abc", cpuMs: cpu, rssBytes: 1e7, start: "d" },
  ];
  const sampler = createProcessSampler({ list: () => lists.shift() ?? null, intervalMs: 60_000, scope: "tree", serverPid: 100, now: () => clock, monotonic: () => mono });
  const limits: EngineLimitsReport = { checkedAt: START, engines: [
    { engine: "ada@example.test", name: "Ada's Claude", driver: "claude", window: "5-hour", usedPercent: 100, resetsAt: START + 7_200_000, blocked: true, held: true },
  ] };
  const perf = createPerfHost({
    dataDir: dir, timer: false, now: () => clock, sampler, wholeMachine: false, limits: () => limits, log: (line) => logged.push(line),
    bus: { subscribe: (listener) => { busListeners.add(listener); return () => busListeners.delete(listener); } },
    store: { onChange: (listener) => { storeListeners.add(listener); return () => storeListeners.delete(listener); },
      botByThread: (threadId) => ({ id: threadId === "thread_ok" ? "bot_ok" : "ada@example.test" }) },
  });
  const emit = (threadId: string, event: Record<string, unknown>) => {
    for (const listener of busListeners) listener({ eventId: "e", provider: "claudeAgent", threadId, createdAt: "", turnId: "turn_1", ...event } as RuntimeEvent);
  };
  const message = (threadId: string, text: string) => {
    for (const listener of storeListeners) listener({ type: "message", threadId, message: { id: "m", at: clock, role: "user", kind: "text", text } } as unknown as StoreChange);
  };
  const advance = (ms: number) => { clock += ms; mono += ms; };

  lists.push({ rows: procRows(1_000), reapedMs: null, totalMs: null });
  await sampler.sampleNow();
  advance(60_000);
  lists.push({ rows: procRows(9_000), reapedMs: null, totalMs: null });
  await sampler.sampleNow();

  for (const threadId of ["thread_ok", "/Users/ada/Projects/acme-merger/plan.md", "https://intranet.acme.test/q?token=abc"]) {
    message(threadId, `${SECRETS.join(" ")} please`);
    advance(4_000);
    emit(threadId, { type: "turn.started" });
    emit(threadId, { type: "session.started", sessionId: "ada@example.test", model: "Ada's Claude" });
    emit(threadId, { type: "content.delta", streamKind: "assistant_text", delta: SECRETS.join("\n") });
    emit(threadId, { type: "item.started", itemType: "tool", itemId: "x1", title: "mcp__acme-internal__lookup_customer", input: SECRETS.join(" ") });
    emit(threadId, { type: "item.started", itemType: "tool", itemId: "x2", title: "cat /Users/ada/Projects/acme-merger/plan.md", summary: "cat /Users/ada/Projects/acme-merger/plan.md" });
    emit(threadId, { type: "request.opened", requestType: "permission", tool: "Bash", summary: SECRETS.join(" "), command: { command: "curl https://intranet.acme.test/q?token=abc", cwd: "/Users/ada/Projects/acme-merger" } });
    advance(200_000);
    emit(threadId, { type: "request.resolved", behavior: "allow", source: "user" });
    emit(threadId, { type: "item.completed", itemType: "tool", itemId: "x1", ok: false, output: SECRETS.join(" ") });
    emit(threadId, { type: "turn.wait_started", resource: "browser:bot-Tallyspoon", holder: { name: "Tallyspoon", task: "Summarize the merger plan" } });
    advance(150_000);
    emit(threadId, { type: "turn.wait_ended", resource: "browser:bot-Tallyspoon", waitedMs: 150_000, outcome: "acquired" });
    emit(threadId, { type: "turn.retrying", attempt: 1, delayMs: 5_000, reason: "Error at https://intranet.acme.test/q?token=abc for ada@example.test" });
    emit(threadId, { type: "runtime.error", message: SECRETS.join(" "), limit: "engine", limitResetsAt: START + 7_200_000 });
    perf.noteFailover(threadId, "limit");
    advance(10_000);
    emit(threadId, { type: "turn.completed", ok: false, stopReason: "OMB_SECRET_VALUE_42 at /Users/ada/Projects/acme-merger/plan.md" });
  }
  const poisoned = { provider: "claudeAgent --token sk-ant-api03-PRIVATEPRIVATEPRIVATE1234567890", turnId: "turn_poisoned" };
  emit("thread_ok", { type: "turn.started", ...poisoned });
  emit("thread_ok", { type: "runtime.error", message: "x", limit: "engine", ...poisoned });
  emit("thread_ok", { type: "turn.completed", ok: false, stopReason: "quota", ...poisoned });
  perf.noteNotStarted("thread_ok", null, { limit: "credits", engine: "hunter2-password at https://intranet.acme.test/q?token=abc" });
  emit("thread_ok", { type: "turn.started", turnId: "turn_live" });
  emit("thread_ok", { type: "item.started", itemType: "tool", itemId: "y", title: "mcp__acme-internal__lookup_customer", turnId: "turn_live" });
  advance(30_000);
  return { perf, logged, dir };
}

const leaks = (text: string) => SECRETS.filter((secret) => text.toLowerCase().includes(secret.toLowerCase()));

describe("performance diagnostics carry no content", () => {
  it("the health read's perf field, the @devs diagnostics, the copied text, the log lines and the saved file hold none of the seeded secrets", async () => {
    const { perf, logged, dir } = await seeded();
    perf.timings.flush();
    const health = JSON.stringify(perf.health());
    const lines = perf.lines({ threadIds: ["thread_ok"], botIds: ["bot_ok"] });
    const report = buildDevsReport({
      installId: "inst_1", appVersion: "0.1.160", platform: "linux x64", os: "linux 6 x64", runsOn: "My Cloud", node: "v24", uptimeSeconds: 60, now: START,
      threadId: "thread_ok", messageId: "m_1", where: "a chat", message: "@devs it is slow", words: "it is slow", bots: [], noSummary: "none", problems: [], log: [],
      performance: lines,
    }, []);
    const text = perf.text();
    const saved = readFileSync(join(dir, PERF_FILE), "utf8");
    expect(logged.length).toBeGreaterThan(0);
    expect(health).toContain('"turns":4');
    expect(perf.timings.recent().find((turn) => turn.turnId === "turn_poisoned")).toMatchObject({ engine: null, limit: "engine" });
    expect(Object.keys(perf.timings.day().limits).sort()).toEqual(["claudeAgent:engine", "unknown:credits", "unknown:engine"]);
    expect(report.diagnostics).toContain("## Performance");
    expect(report.diagnostics).toContain("thread_ok");
    expect(text).toContain("mcp ");
    for (const [where, body] of Object.entries({ health, diagnostics: report.diagnostics, text, log: logged.join("\n"), saved })) {
      expect(leaks(body), where).toEqual([]);
    }
  });

  it("rides the signed health report as `perf`, and is null where no recorder is wired", async () => {
    const { perf } = await seeded();
    const store = { onChange: () => () => {}, botByThread: () => null, bots: [] };
    const bus = { subscribe: () => () => {} };
    const base = { store, bus, engines: () => [], dataDir: tmpdir(), eventsDir: tmpdir(), version: "0.1.160", image: undefined, connectors: () => null,
      browser: () => ({ available: true, installing: false, interrupted: 0 }), now: () => START };
    expect(createCloudHealth(base).report(undefined).perf).toBeNull();
    const report = createCloudHealth({ ...base, perf: perf.health }).report(undefined);
    expect(report.perf).toMatchObject({ v: 1, h24: { turns: 4, failovers: 3, limits: { "claudeAgent:engine": 3 } }, holds: [{ driver: "claude", window: "5-hour", blocked: true }] });
    expect(leaks(JSON.stringify(report.perf))).toEqual([]);
  });
});

describe("a tampered file read back", () => {
  it("passes nothing but checked fields: every string a secret, every key a trap", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-tampered-"));
    dirs.push(dir);
    const file = join(dir, PERF_FILE);
    const bad = SECRETS.join(" ");
    const hour = Math.floor(START / 3_600_000);
    writeFileSync(file, JSON.stringify({ v: 1,
      ring: [{ startedAt: START - 5_000, endedAt: START - 1_000, ok: true, stop: bad, turnId: bad, threadId: "/Users/ada/Projects/acme-merger/plan.md", botId: "ada@example.test",
        engine: "https://intranet.acme.test/q?token=abc", queueWhy: bad, retryWhy: [bad, "__proto__", "constructor"], limit: bad, failover: bad, retries: 1, backoffMs: 1,
        ms: { total: 4_000, [bad]: 1, __proto__: { polluted: 1 } }, tools: [{ kind: bad, n: 1 }, { kind: "browser", n: 1, ms: 9, max: 9, errors: 0, open: 0, extra: bad }] }],
      day: [{ hour, turns: 1, failed: 0, slow: [0, 0, 0], failovers: 0, phases: { total: { counts: [bad], max: 1, sum: 1 } },
        tools: { [bad]: { hist: {} }, constructor: { hist: {} } }, retries: { turns: 1, n: 1, backoffMs: 1, why: { [bad]: 1, toString: 2, overloaded: 1 } },
        limits: { [bad]: 1, "constructor:engine": 1, [`${bad}:engine`]: 1 } }] }));
    const timings = createTurnTimings({ file, now: () => START });
    const out = JSON.stringify({ recent: timings.recent(), hour: timings.window(), day: timings.day(),
      health: perfHealth({ hour: timings.window(), day: timings.day(), live: timings.live(), limits: null, process: null }) });
    expect(leaks(out)).toEqual([]);
    expect(timings.recent()[0]).toMatchObject({ threadId: null, botId: null, engine: null, stop: "ok", retryWhy: ["other", "other", "other"], tools: [{ kind: "browser" }] });
    expect({ ...timings.day().retries.why }).toEqual({ overloaded: 1 });
    expect({ ...timings.day().limits }).toEqual({ "constructor:engine": 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("the perf field's size", () => {
  it("stays under PERF_HEALTH_MAX_BYTES with every part at its fullest", () => {
    let clock = START;
    const big = createTurnTimings({ now: () => clock });
    const kinds = ["mcp__browser__a", "mcp__computer__a", "Bash", "Read", "WebSearch", "WebFetch", "mcp__x__y", "remember", "routine", "publish_page",
      "show_widget", "delegate", "phone_tap", "TodoWrite", "generate_image", "mcp__data__q", "GMAIL_SEND_EMAIL", "anything"];
    for (let turn = 0; turn < 300; turn++) {
      const threadId = `thread_${turn}`;
      big.noteEvent({ eventId: "e", provider: "someVeryLongEngineKindName-abcdefghijk", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.started" });
      kinds.forEach((title, index) => big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "item.started", itemType: "tool", itemId: `i${index}`, title }));
      for (let retry = 0; retry < 4; retry++) big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.retrying", attempt: retry, delayMs: 1000, reason: `reason_${(turn * 4 + retry) % 20}` });
      big.noteEvent({ eventId: "e", provider: `engine${turn % 20}`, threadId, createdAt: "", turnId: `t${turn}`, type: "runtime.error", message: "m", limit: (["engine", "model", "credits"] as const)[turn % 3] });
      clock += 1_234_567;
      if (turn < 250) big.noteEvent({ eventId: "e", provider: "p", threadId, createdAt: "", turnId: `t${turn}`, type: "turn.completed", ok: turn % 2 === 0 });
    }
    clock = START + 250 * 1_234_567;
    const proc = { at: clock, intervalS: 60, scope: "all" as const, samples: 60, browsers: 9, unseen60mS: 1234.5,
      buckets: Array.from({ length: 12 }, (_, index) => ({ bucket: `engine:someVeryLongEngineKindName${index}` as const, procs: 99, cpu5mS: 1234.5, cpu60mS: 12345.6, peakPct: 100, rssMB: 4096 })),
      loop: { eluPct: 100, eluMaxPct: 100, driftP95Ms: 123_456, driftMaxMs: 1_234_567 } };
    const limits: EngineLimitsReport = { checkedAt: 0, engines: Array.from({ length: 20 }, (_, index) => ({ engine: `e${index}`, name: "n", driver: "claude" as const,
      window: "weekly" as const, usedPercent: 100, resetsAt: START + index, blocked: true, held: true })) };
    const body = perfHealth({ hour: big.window(), day: big.day(), live: big.live(), limits, process: proc });
    const bytes = JSON.stringify(body).length;
    console.log(`perf health, every part full: ${bytes} bytes (budget ${PERF_HEALTH_MAX_BYTES})`);
    expect(bytes).toBeLessThanOrEqual(PERF_HEALTH_MAX_BYTES);
    expect(body.h24.tools.length).toBeGreaterThan(0);
  });
});

describe("the recorder's cost", () => {
  it("handles a busy day's events in microseconds each, and its memory stays bounded", () => {
    let clock = START;
    const timings = createTurnTimings({ now: () => clock });
    const events: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 40; index++) events.push({ type: "content.delta", streamKind: "assistant_text", delta: "token " });
    for (let index = 0; index < 8; index++) events.push({ type: "item.started", itemType: "tool", itemId: `i${index}`, title: "Bash", summary: "ls" }, { type: "item.completed", itemType: "tool", itemId: `i${index}`, ok: true });
    const turns = 5_000;
    const started = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      const threadId = `thread_${turn % 50}`;
      const base = { eventId: "e", provider: "claudeAgent", threadId, createdAt: "", turnId: `t${turn}` };
      timings.noteMessage(threadId, { at: clock, role: "user", kind: "text" } as never);
      timings.noteEvent({ ...base, type: "turn.started" } as RuntimeEvent);
      for (const event of events) { clock += 10; timings.noteEvent({ ...base, ...event } as RuntimeEvent); }
      timings.noteEvent({ ...base, type: "turn.completed", ok: true } as RuntimeEvent);
    }
    const elapsed = performance.now() - started;
    const perEventUs = (elapsed * 1000) / (turns * (events.length + 2));
    const reportStarted = performance.now();
    for (let index = 0; index < 100; index++) { timings.window(); timings.day(); }
    const reportMs = (performance.now() - reportStarted) / 100;
    console.log(`recorder: ${perEventUs.toFixed(2)} µs per event over ${turns * (events.length + 2)} events; window()+day() ${reportMs.toFixed(2)} ms`);
    expect(perEventUs).toBeLessThan(50);
    expect(reportMs).toBeLessThan(50);
    expect(timings.recent()).toHaveLength(200);
    expect(timings.live()).toHaveLength(0);
  });
});
