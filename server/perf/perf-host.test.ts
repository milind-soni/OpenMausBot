import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineLimitsReport } from "../../shared/limit-reset.ts";
import { createPerfDiagnosticsRoutes, PERF_DIAGNOSTICS_PATH } from "../routes/perf-diagnostics.ts";
import { PASS, type RouteContext } from "../routes/table.ts";
import { createPerfHost, LOG_EVERY_MS, rateLimitedLog } from "./perf-host.ts";
import { createProcessSampler } from "./process-sampler.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("slow-event log lines", () => {
  it("prints one line per kind a minute and counts the ones held back", () => {
    let clock = 0;
    const lines: string[] = [];
    const say = rateLimitedLog((line) => lines.push(line), () => clock);
    say("turn", "a");
    say("turn", "b");
    say("tool", "c");
    clock += LOG_EVERY_MS;
    say("turn", "d");
    expect(lines).toEqual(["[perf] a", "[perf] c", "[perf] d (+1 more since the last)"]);
  });

  it("says when a usage-limit hold starts and ends, and reads no limits before the limit clock exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "perf-host-"));
    dirs.push(dir);
    let clock = 1_800_000_000_000;
    let limits: EngineLimitsReport | null = null;
    const lines: string[] = [];
    const sampler = createProcessSampler({ list: () => null, intervalMs: 60_000, scope: "tree", now: () => clock });
    const host = createPerfHost({
      dataDir: dir, timer: false, sampler, wholeMachine: false, now: () => clock, log: (line) => lines.push(line),
      limits: () => { if (!limits) throw new ReferenceError("not made yet"); return limits; },
      bus: { subscribe: () => () => {} }, store: { onChange: () => () => {}, botByThread: () => null },
    });
    expect(host.health().holds).toEqual([]);
    host.checkHolds();
    limits = { checkedAt: clock, engines: [{ engine: "claude-2", name: "Ada's Claude", driver: "claude", window: "weekly", usedPercent: 100, resetsAt: clock + 3_600_000, blocked: true }] };
    expect(host.health().holds).toEqual([{ driver: "claude", window: "weekly", usedPercent: 100, resetsAt: clock + 3_600_000, blocked: true, held: false }]);
    expect(host.text()).toContain("Usage limits now: claude weekly 100% refusing work until");
    host.checkHolds();
    host.checkHolds();
    clock += LOG_EVERY_MS;
    limits = { checkedAt: clock, engines: [] };
    host.checkHolds();
    expect(lines).toEqual(["[perf] usage limit hold started: claude:weekly", "[perf] usage limit hold ended: claude:weekly"]);
    host.stop();
  });
});

describe("GET /api/diagnostics/performance", () => {
  it("answers with the text and passes every other request on", async () => {
    const route = createPerfDiagnosticsRoutes({ text: () => "## Performance\nLast hour: 0 turns" });
    const sent: Array<{ status: number; body: unknown }> = [];
    const headers: Record<string, string> = {};
    const context = (path: string, method = "GET") => ({
      path, method, res: { setHeader: (name: string, value: string) => { headers[name] = value; } },
      json: (_res: unknown, status: number, body: unknown) => { sent.push({ status, body }); },
    }) as unknown as RouteContext;
    expect(await route(context("/api/limit-resets"))).toBe(PASS);
    expect(await route(context(PERF_DIAGNOSTICS_PATH, "POST"))).toBe(PASS);
    await route(context(PERF_DIAGNOSTICS_PATH));
    expect(sent).toEqual([{ status: 200, body: { text: "## Performance\nLast hour: 0 turns" } }]);
    expect(headers["cache-control"]).toBe("no-store");
  });
});
