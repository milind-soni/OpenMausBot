import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TraceGroup, TraceStep, TraceTool, TraceTurn } from "../../shared/usage-trace.ts";
import { monthKey, type UsageRow } from "../usage-ledger.ts";
import { groupRuns, linkTurns, summarizeRoot, traceTurn } from "./build.ts";
import { ledgerRows } from "./ledger.ts";
import { createTraceService } from "./service.ts";
import { appendSpans, flushSpans, type SpanRecord } from "./spans.ts";

const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const noBot = () => null;

function row(fields: Partial<UsageRow> & Pick<UsageRow, "threadId" | "botId">): UsageRow {
  return {
    at: iso(10_000), botName: fields.botId[0]!.toUpperCase() + fields.botId.slice(1), instanceId: "claude", driverKind: "claude",
    model: "claude-sonnet-5-5", input: 1_000, output: 100, cachedInput: 600, costUsd: 0.1, costSource: "reported", trigger: { kind: "owner" },
    ...fields,
  };
}
const timed = (threadId: string, botId: string, turnId: string, start: number, end: number, extra: Partial<UsageRow> = {}) =>
  row({ threadId, botId, turnId, startedAt: iso(start), endedAt: iso(end), at: iso(end), steps: 1, tools: 0, toolErrors: 0, usageStatus: "complete", ...extra });
const tool = (threadId: string, turnId: string, id: string, name: string, start: number, end: number, status: "ok" | "error" = "ok"): SpanRecord =>
  ({ kind: "tool", id: `${threadId}:${turnId}:${id}`, threadId, turnId, name, startedAt: T0 + start, endedAt: T0 + end, status, timedBy: "engine" });
const step = (threadId: string, turnId: string, n: number, start: number, end: number, output = 10): SpanRecord =>
  ({ kind: "step", id: `${threadId}:${turnId}:step-${n}`, threadId, turnId, startedAt: T0 + start, endedAt: T0 + end, tokens: { input: 100, cachedInput: 0, output } });

describe("trace tree", () => {
  it("nests delegated turns under the turn that started them and adds up the whole job", () => {
    const rows = [
      timed("chief", "chief", "c1", 0, 5_000, { tools: 1, trigger: { kind: "user", label: "Ada" } }),
      timed("research", "researcher", "r1", 1_000, 31_000, { parent: { threadId: "chief", turnId: "c1" }, tools: 4, toolErrors: 1, steps: 3, costUsd: 0.05 }),
      timed("writer", "writer", "w1", 2_000, 40_000, { parent: { threadId: "chief", turnId: "c1" }, steps: 2, costUsd: null, outcome: { status: "error", reason: "overloaded" } }),
      timed("writer", "writer", "w2", 41_000, 42_000, { parent: { threadId: "research", turnId: "r1" } }),
      timed("chief", "chief", "c9", 100_000, 101_000),
    ];
    const roots = linkTurns(rows, [], noBot);
    expect(roots.map((root) => root.key).sort()).toEqual(["chief:c1", "chief:c9"]);
    const job = roots.find((root) => root.key === "chief:c1")!;
    expect(job.children.map((child) => child.key)).toEqual(["research:r1", "writer:w1"]);
    expect(job.children[0]!.children.map((child) => child.key)).toEqual(["writer:w2"]);
    const summary = summarizeRoot(job, "Launch the pricing page", T0 + 200_000);
    expect(summary).toMatchObject({
      id: "chief~c1", title: "Launch the pricing page", source: "person", durationMs: 42_000, steps: 7, tools: 5, errors: 2,
      input: 4_000, cachedInput: 2_400, output: 400, tokens: 4_400, running: false, timed: true, usageStatus: "complete",
      bots: [{ id: "chief", name: "Chief" }, { id: "researcher", name: "Researcher" }, { id: "writer", name: "Writer" }],
    });
    expect(summary.costUsd).toBeCloseTo(0.25);
  });

  it("draws each turn's AI steps and tools on one time axis, with the step's share of the cost", () => {
    const [root] = linkTurns([timed("bot", "bot", "t1", 0, 10_000, { costUsd: 0.3 })], [], noBot);
    const spans = new Map([["bot:t1", [step("bot", "t1", 1, 0, 2_000, 10), tool("bot", "t1", "a", "WebSearch", 2_000, 7_000), step("bot", "t1", 2, 7_000, 10_000, 30)]]]);
    const turn = traceTurn(root!, spans);
    expect(turn.children.map((child) => [child.kind, child.startedAt - T0])).toEqual([["step", 0], ["tool", 2_000], ["step", 7_000]]);
    const [first, search, second] = turn.children as [TraceStep, TraceTool, TraceStep];
    expect(search).toMatchObject({ icon: "search", endedAt: T0 + 7_000, status: "ok" });
    expect(first.costUsd! + second.costUsd!).toBeCloseTo(0.3);
    expect(second.costUsd!).toBeGreaterThan(first.costUsd!);
  });

  it("shows turns booked before timing existed as flat, untimed roots, and a timed turn with no spans as one step", () => {
    const old = row({ threadId: "bot", botId: "bot", at: iso(5_000) });
    const roots = linkTurns([old, { ...old, at: iso(6_000) }, timed("bot", "bot", "t1", 7_000, 9_000)], [], noBot);
    expect(roots).toHaveLength(3);
    const flat = roots.find((root) => !root.turnId)!;
    expect(summarizeRoot(flat, "", T0)).toMatchObject({ timed: false, durationMs: 0, usageStatus: "complete" });
    expect(traceTurn(flat, new Map()).children).toEqual([]);
    expect(traceTurn(roots.find((root) => root.turnId)!, new Map()).children).toMatchObject([{ kind: "step", startedAt: T0 + 7_000, endedAt: T0 + 9_000 }]);
  });

  it("folds a long run of one kind of tool into a group and keeps short runs apart", () => {
    const items = [
      ...[0, 1, 2, 3].flatMap((n) => [
        { kind: "tool", id: `b${n}`, name: "mcp__browser__agent_browser_click", icon: "browser", startedAt: n * 100, endedAt: n * 100 + 40, status: n === 2 ? "error" : "ok", timedBy: "engine" } as TraceTool,
        { kind: "step", id: `s${n}`, startedAt: n * 100 + 40, endedAt: n * 100 + 100 } as TraceStep,
      ]),
      { kind: "tool", id: "x", name: "Bash", icon: "terminal", startedAt: 500, endedAt: 510, status: "ok", timedBy: "engine" } as TraceTool,
    ];
    const folded = groupRuns(items);
    expect(folded.map((item) => item.kind)).toEqual(["group", "step", "tool"]);
    expect(folded[0]).toMatchObject({ icon: "browser", count: 4, errors: 1, startedAt: 0, endedAt: 340 });
    expect((folded[0] as TraceGroup).children).toHaveLength(7);
  });

  it("includes a running turn with its spans so far, and refuses a parent loop", () => {
    const rows = [timed("a", "alpha", "t1", 0, 1_000, { parent: { threadId: "b", turnId: "t2" } }), timed("b", "beta", "t2", 0, 1_000, { parent: { threadId: "a", turnId: "t1" } })];
    expect(linkTurns(rows, [], noBot)).toHaveLength(2);
    const roots = linkTurns([timed("chief", "chief", "c1", 0, 1_000)], [{
      threadId: "helper", turnId: "h1", provider: "claude", startedAt: T0 + 500, parent: { threadId: "chief", turnId: "c1" },
      spans: [{ ...step("helper", "h1", 1, 500, 900), endedAt: undefined, running: true } as SpanRecord & { running: boolean }],
    }], () => ({ botId: "helper", botName: "Helper", model: "gpt-6", driverKind: "codex" }));
    const summary = summarizeRoot(roots[0]!, "", T0 + 5_000);
    expect(summary).toMatchObject({ running: true, durationMs: 5_000, bots: [{ id: "chief", name: "Chief" }, { id: "helper", name: "Helper" }] });
    const child = traceTurn(roots[0]!, new Map()).children.find((node): node is TraceTurn => node.kind === "turn")!;
    expect(child).toMatchObject({ running: true, botName: "Helper", children: [{ kind: "step", running: true }] });
  });
});

describe("trace service", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("reads only the ledger lines added since the last read, once, however many requests overlap", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-trace-ledger-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "usage"), { recursive: true });
    const ledger = join(dataDir, "usage", `${monthKey(new Date(T0))}.jsonl`);
    const add = (n: number) => { for (let index = 0; index < n; index += 1) appendFileSync(ledger, JSON.stringify(timed(`t-${Math.random()}`, "bot", "x", 0, 10)) + "\n"); };
    const range: [string, number, number] = [dataDir, T0 - 60_000, T0 + 60_000];
    add(3);
    expect(await ledgerRows(...range)).toHaveLength(3);
    add(2);
    appendFileSync(ledger, '{"half a line');
    const [first, second] = await Promise.all([ledgerRows(...range), ledgerRows(...range)]);
    expect([first.length, second.length]).toEqual([5, 5]);
    appendFileSync(ledger, '", "x": 1}\n');
    add(1);
    expect(await ledgerRows(...range)).toHaveLength(6);
  });

  it("builds a 500-span trace from disk in well under 100 ms and pages the runs list", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-trace-service-"));
    dirs.push(dataDir);
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    mkdirSync(join(dataDir, "usage"), { recursive: true });
    const ledger = join(dataDir, "usage", `${monthKey(new Date(T0))}.jsonl`);
    for (let index = 0; index < 400; index += 1) appendFileSync(ledger, JSON.stringify(timed(`noise-${index}`, "other", "n", index * 10, index * 10 + 5)) + "\n");
    appendFileSync(ledger, JSON.stringify(timed("chief", "chief", "c1", 0, 600_000, { tools: 1, trigger: { kind: "user", label: "Ada" } })) + "\n");
    appendFileSync(ledger, JSON.stringify(timed("worker", "worker", "w1", 1_000, 590_000, { parent: { threadId: "chief", turnId: "c1" }, tools: 249, steps: 250 })) + "\n");
    const spans: SpanRecord[] = [];
    for (let index = 0; index < 250; index += 1) {
      spans.push(step("worker", "w1", index, 1_000 + index * 2_000, 2_000 + index * 2_000));
      spans.push(tool("worker", "w1", `t${index}`, "mcp__computer__click", 2_000 + index * 2_000, 3_000 + index * 2_000));
    }
    appendSpans(dataDir, spans, true);
    await flushSpans(dataDir);
    const service = createTraceService({
      dataDir, recorder: { liveTurns: () => [] }, liveBot: () => null, now: () => now,
      messages: (threadId) => threadId === "chief" ? [{ id: "m1", role: "user", kind: "text", text: "Tidy the  CRM\nplease", at: T0 - 100 }] : [],
    });
    const range = { from: new Date(Date.UTC(2026, 9, 22)), to: new Date(now) };
    const page = await service.list(range, { offset: 0, limit: 50 }, () => true);
    expect(page.roots).toHaveLength(50);
    expect(page.next).toBe(50);
    expect(page.totals.tools).toBe(250);
    const begin = performance.now();
    const detail = await service.detail("worker~w1", T0, () => true);
    const ms = performance.now() - begin;
    console.log(`trace service: 500-span trace built from disk in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(100);
    expect(detail!.root).toMatchObject({ id: "chief~c1", title: "Tidy the CRM please", tools: 250 });
    const worker = detail!.turns[0]!.children.find((node): node is TraceTurn => node.kind === "turn")!;
    expect(worker.children.map((node) => node.kind)).toEqual(["step", "group"]);
    expect(worker.children[1]).toMatchObject({ icon: "computer", count: 250 });
    expect(await service.detail("worker~w1", T0, (threadId) => threadId !== "chief")).toBeNull();
    const hidden = await service.detail("chief~c1", T0, (threadId) => threadId === "chief");
    expect(hidden!.turns[0]!.children.some((node) => node.kind === "turn")).toBe(false);
  });
});
