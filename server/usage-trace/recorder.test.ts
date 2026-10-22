import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { json, readBody } from "../harness/http.ts";
import { createTraceRecorder } from "./recorder.ts";
import { daysBetween, flushSpans, readSpans } from "./spans.ts";

const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);
const dirs: string[] = [];
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-trace-recorder-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

let serial = 0;
function event(threadId: string, turnId: string | undefined, ms: number, body: Record<string, unknown>, provider = "claude"): RuntimeEvent {
  return { eventId: `e${++serial}`, provider, threadId, ...(turnId ? { turnId } : {}), createdAt: new Date(T0 + ms).toISOString(), ...body } as RuntimeEvent;
}
const started = (thread: string, turn: string, ms: number, provider?: string) => event(thread, turn, ms, { type: "turn.started" }, provider);
const tool = (thread: string, turn: string, ms: number, itemId: string, title: string, input?: unknown) =>
  event(thread, turn, ms, { type: "item.started", itemType: "tool", itemId, title, ...(input ? { input: JSON.stringify(input) } : {}) });
const done = (thread: string, turn: string, ms: number, itemId: string, ok = true, output?: string) =>
  event(thread, turn, ms, { type: "item.completed", itemType: "tool", itemId, ok, ...(output ? { output } : {}) });
const usage = (thread: string, turn: string, ms: number, fields: Record<string, unknown>, provider?: string) =>
  event(thread, turn, ms, { type: "thread.token-usage.updated", ...fields }, provider);
const completed = (thread: string, turn: string, ms: number, ok = true, extra: Record<string, unknown> = {}) =>
  event(thread, turn, ms, { type: "turn.completed", ok, usage: { input: 900, output: 60, cachedInput: 400 }, ...extra });

describe("trace recorder", () => {
  it("times each AI step and tool from the engine's own events and hands the turn to its usage row", async () => {
    const dir = dataDir();
    const recorder = createTraceRecorder({ dataDir: dir });
    recorder.observe(started("chief", "t1", 0));
    recorder.observe(usage("chief", "t1", 2_000, { itemId: "msg_1", input: 500, cachedInput: 400, output: 3, contextTokens: 520 }));
    recorder.observe(tool("chief", "t1", 2_100, "toolu_1", "WebSearch", { query: "pricing pages" }));
    recorder.observe(usage("chief", "t1", 2_150, { itemId: "msg_1", input: 500, cachedInput: 400, output: 40, contextTokens: 520 }));
    recorder.observe(done("chief", "t1", 7_500, "toolu_1"));
    recorder.observe(usage("chief", "t1", 9_000, { itemId: "msg_2", input: 600, cachedInput: 500, output: 20, contextTokens: 600 }));
    recorder.observe(completed("chief", "t1", 9_500));
    const row = recorder.settle("chief");
    expect(row).toMatchObject({
      turnId: "t1", startedAt: new Date(T0).toISOString(), endedAt: new Date(T0 + 9_500).toISOString(),
      outcome: { status: "ok" }, steps: 2, tools: 1, toolErrors: 0, cacheWrite: 20, contextTokens: 600, usageStatus: "complete",
    });
    expect(row).not.toHaveProperty("parent");
    expect(recorder.settle("chief")).toEqual({});
    await flushSpans(dir);
    const spans = (await readSpans(dir, daysBetween(T0, T0 + 10_000), new Set(["chief:t1"]))).get("chief:t1")!;
    const steps = spans.filter((span) => span.kind === "step");
    expect(steps.map((step) => [step.startedAt - T0, step.endedAt! - T0])).toEqual([[0, 2_100], [7_500, 9_500]]);
    expect(steps[0]).toMatchObject({ tokens: { input: 500, cachedInput: 400, output: 40, cacheWrite: 20 } });
    expect(spans.find((span) => span.kind === "tool")).toMatchObject({
      name: "WebSearch", detail: "pricing pages", startedAt: T0 + 2_100, endedAt: T0 + 7_500, status: "ok", timedBy: "engine",
    });
  });

  it("links a delegated turn, a resumed turn and a room handoff to the turns that started them", () => {
    const recorder = createTraceRecorder({ dataDir: dataDir() });
    recorder.observe(started("chief", "c1", 0));
    recorder.link("node-b", "node-a", { threadId: "chief", turnId: "c1" });
    recorder.observe(completed("chief", "c1", 1_000));
    recorder.settle("chief");
    recorder.expect("writer", { node: "node-b" });
    recorder.observe(started("writer", "w1", 1_500));
    recorder.observe(completed("writer", "w1", 4_000));
    expect(recorder.settle("writer")).toMatchObject({ turnId: "w1", parent: { threadId: "chief", turnId: "c1" } });
    recorder.expect("chief", { node: "node-a", resumed: true });
    recorder.observe(started("chief", "c2", 4_200));
    recorder.observe(completed("chief", "c2", 5_000));
    expect(recorder.settle("chief")).toMatchObject({ turnId: "c2", parent: { threadId: "chief", turnId: "c1" } });
    recorder.expect("room", { parent: { threadId: "room", turnId: "r1" } });
    recorder.observe(started("room", "r2", 6_000));
    recorder.observe(completed("room", "r2", 7_000));
    expect(recorder.settle("room")).toMatchObject({ parent: { threadId: "room", turnId: "r1" } });
    expect(recorder.liveTurns()).toEqual([]);
    recorder.observe(started("writer", "w2", 8_000));
    recorder.observe(done("writer", "w1", 8_100, "late-item"));
    recorder.observe(started("writer", "w1", 8_200));
    recorder.observe(completed("writer", "w2", 9_000));
    const unlinked = recorder.settle("writer");
    expect(unlinked).toMatchObject({ turnId: "w2", tools: 0 });
    expect(unlinked).not.toHaveProperty("parent");
    expect(recorder.settle("writer")).toEqual({});
  });

  it("closes a tool still open at the turn's end, keeps one span per engine id, and says why a turn failed", async () => {
    const dir = dataDir();
    const recorder = createTraceRecorder({ dataDir: dir });
    recorder.observe(started("bot", "t1", 0));
    recorder.observe(tool("bot", "t1", 100, "a", "Bash", { command: "pnpm test" }));
    recorder.observe(tool("bot", "t1", 100, "a", "Bash", { command: "pnpm test" }));
    recorder.observe(done("bot", "t1", 900, "a", false, "Error: 3 tests failed\nat line 4"));
    recorder.observe(tool("bot", "t1", 1_000, "b", "mcp__browser__agent_browser_open", { url: "https://www.example.com/pricing" }));
    recorder.observe(event("bot", "t1", 1_100, { type: "runtime.error", message: "Claude API overloaded (529)" }));
    recorder.observe(event("bot", "t1", 1_200, { type: "turn.completed", ok: false, stopReason: "api_error" }));
    expect(recorder.settle("bot")).toMatchObject({ tools: 2, toolErrors: 1, outcome: { status: "error", reason: "Claude API overloaded (529)" }, usageStatus: "unavailable" });
    await flushSpans(dir);
    const tools = (await readSpans(dir, daysBetween(T0, T0), new Set(["bot:t1"]))).get("bot:t1")!.filter((span) => span.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ status: "error", error: "Error: 3 tests failed", detail: "pnpm test" });
    expect(tools[1]).toMatchObject({ status: "ended", endedAt: T0 + 1_200, detail: "example.com/pricing" });
  });

  it("takes OMB's own timing for the tools it serves, and keeps a served call the engine never reported", async () => {
    const dir = dataDir();
    const recorder = createTraceRecorder({ dataDir: dir });
    recorder.observe(started("bot", "t1", 0));
    recorder.observe(tool("bot", "t1", 1_000, "toolu_9", "mcp__agents__coordinate_bots"));
    recorder.receipt("bot", { name: "coordinate_bots", startedAt: T0 + 1_150, endedAt: T0 + 1_900, ok: true });
    recorder.observe(done("bot", "t1", 2_000, "toolu_9"));
    recorder.receipt("bot", { name: "list_room_targets", startedAt: T0 + 3_000, endedAt: T0 + 3_400, ok: false, error: "Not allowed" });
    recorder.observe(completed("bot", "t1", 5_000));
    expect(recorder.settle("bot")).toMatchObject({ steps: 3, tools: 2, toolErrors: 1 });
    await flushSpans(dir);
    const spans = (await readSpans(dir, daysBetween(T0, T0), new Set(["bot:t1"]))).get("bot:t1")!;
    expect(spans.filter((span) => span.kind === "tool").map((span) => span.kind === "tool" && [span.name, span.startedAt - T0, span.endedAt! - T0, span.timedBy, span.status]))
      .toEqual([["mcp__agents__coordinate_bots", 1_150, 1_900, "omb", "ok"], ["list_room_targets", 3_000, 3_400, "omb", "error"]]);
    expect(spans.filter((span) => span.kind === "step").map((span) => [span.startedAt - T0, span.endedAt! - T0]))
      .toEqual([[0, 1_000], [2_000, 3_000], [3_400, 5_000]]);
  });

  it("times the browser, computer and app calls OMB answers itself, and reads their failure from the answer", async () => {
    const recorder = createTraceRecorder({ dataDir: dataDir() });
    recorder.observe(event("bot", "t1", Date.now() - T0, { type: "turn.started" }));
    const server = createServer(async (req, res) => {
      await readBody(req);
      recorder.timeServed(req, res, "bot");
      await new Promise((resolve) => setTimeout(resolve, 30));
      json(res, 200, { result: { isError: req.url === "/fail", content: [{ type: "text", text: "Element @e12 is not visible\nmore" }] } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const call = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: JSON.stringify(body) });
    await call("/ok", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_browser_open", arguments: { url: "https://www.figma.com/pricing" } } });
    await call("/fail", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_browser_click", arguments: { ref: "@e12" } } });
    await call("/ok", { jsonrpc: "2.0", id: 3, method: "tools/list" });
    server.close();
    const tools = recorder.liveTurns()[0]!.spans.filter((span) => span.kind === "tool");
    expect(tools.map((tool) => tool.kind === "tool" && [tool.name, tool.status, tool.timedBy, tool.detail, tool.error])).toEqual([
      ["agent_browser_open", "ok", "omb", "figma.com/pricing", undefined],
      ["agent_browser_click", "error", "omb", undefined, "Element @e12 is not visible"],
    ]);
    expect(tools.every((tool) => tool.endedAt! - tool.startedAt >= 25)).toBe(true);
  });

  it("closes a turn its engine abandoned, forgets a stale expected start, and ignores a receipt from outside the turn", async () => {
    let clock = T0;
    const dir = dataDir();
    const recorder = createTraceRecorder({ dataDir: dir, now: () => clock });
    recorder.observe(started("bot", "t1", 0));
    recorder.observe(tool("bot", "t1", 500, "a", "Bash"));
    recorder.observe(started("bot", "t2", 2_000));
    recorder.observe(completed("bot", "t1", 3_000));
    expect(recorder.liveTurns().map((turn) => turn.turnId)).toEqual(["t2"]);
    recorder.receipt("bot", { name: "list_bots", startedAt: T0 - 60_000, endedAt: T0 - 59_000, ok: true });
    recorder.receipt("bot", { name: "list_bots", startedAt: T0 + 2_100, endedAt: T0 + 1e12, ok: true });
    expect(recorder.liveTurns()[0]!.spans.filter((span) => span.kind === "tool")).toEqual([]);
    clock = T0 + 31 * 60_000;
    expect(recorder.liveTurns()).toEqual([]);
    recorder.expect("writer", { parent: { threadId: "chief", turnId: "c1" } });
    clock += 61_000;
    recorder.observe(event("writer", "w1", clock - T0, { type: "turn.started" }));
    recorder.observe(event("writer", "w1", clock - T0 + 10, { type: "turn.completed", ok: true }));
    expect(recorder.settle("writer")).not.toHaveProperty("parent");
    await flushSpans(dir);
    const t1 = (await readSpans(dir, daysBetween(T0, T0), new Set(["bot:t1"]))).get("bot:t1")!;
    expect(t1.find((span) => span.kind === "tool")).toMatchObject({ status: "ended", endedAt: T0 + 500 });
  });

  it("takes each Codex turn's share of the thread's running total", () => {
    const recorder = createTraceRecorder({ dataDir: dataDir(), now: () => T0 + 3_000 });
    recorder.observe(started("codex", "t1", 0, "codex"));
    recorder.observe(usage("codex", "t1", 500, { input: 1_000, output: 100, cachedInput: 200, reasoning: 30 }, "codex"));
    recorder.observe(completed("codex", "t1", 1_000));
    recorder.settle("codex");
    recorder.observe(started("codex", "t2", 2_000, "codex"));
    recorder.observe(usage("codex", "t2", 2_500, { input: 1_800, output: 160, cachedInput: 900, reasoning: 50 }, "codex"));
    const live = recorder.liveTurns().find((turn) => turn.turnId === "t2")!;
    expect(live.spans.find((span) => span.kind === "step")).toMatchObject({ running: true, tokens: { input: 800, output: 60, cachedInput: 700, reasoning: 20 } });
  });

  it("records 2,000 tool calls in one turn without holding up the event loop", async () => {
    const dir = dataDir();
    const recorder = createTraceRecorder({ dataDir: dir });
    const delay = monitorEventLoopDelay({ resolution: 1 });
    let busyMs = 0;
    const observe = (value: RuntimeEvent) => {
      const begin = performance.now();
      recorder.observe(value);
      busyMs += performance.now() - begin;
    };
    delay.enable();
    observe(started("busy", "t1", 0));
    for (let index = 0; index < 2_000; index += 1) {
      observe(tool("busy", "t1", index * 10, `item-${index}`, "mcp__browser__agent_browser_click", { url: "https://example.com/a" }));
      observe(done("busy", "t1", index * 10 + 5, `item-${index}`));
      if (index % 50 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    const end = performance.now();
    observe(completed("busy", "t1", 20_100));
    expect(recorder.settle("busy")).toMatchObject({ tools: 2_000 });
    const settleMs = performance.now() - end;
    await flushSpans(dir);
    delay.disable();
    console.log(`trace recorder: 2,000 tool calls; ${(busyMs * 1000 / 4_002).toFixed(1)} µs per event (${busyMs.toFixed(1)} ms in all), ` +
      `turn end + booking ${settleMs.toFixed(1)} ms, event-loop delay p99 ${(delay.percentile(99) / 1e6).toFixed(1)} ms`);
    expect(busyMs / 4_002).toBeLessThan(0.1);
    expect(settleMs).toBeLessThan(50);
    const spans = (await readSpans(dir, daysBetween(T0, T0 + 30_000), new Set(["busy:t1"]))).get("busy:t1")!;
    expect(spans.filter((span) => span.kind === "tool")).toHaveLength(2_000);
  });
});
