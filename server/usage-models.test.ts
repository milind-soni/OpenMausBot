import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTrainingDataRoutes } from "./routes/training-data.ts";
import type { RouteContext } from "./routes/table.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { TrainingLog } from "./training-log.ts";
import type { UsageRow } from "./usage-ledger.ts";
import { modelPerformance, quickFallbacks } from "./usage-models.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const row = (model: string, extra: Partial<UsageRow> = {}): UsageRow => ({
  at: "2026-11-09T10:00:00.000Z", botId: "b", botName: "B", threadId: "t", instanceId: "i", driverKind: "openai-compat", model,
  input: 100, output: 50, costUsd: null, trigger: { kind: "owner" }, ...extra,
});

describe("model performance", () => {
  it("sums each model's turns, outcomes, tools, time and tokens, and counts a fallback against the quick model", () => {
    const rows = [
      row("qwen-local", { route: "quick", quickModel: "qwen-local", outcome: { status: "ok" }, steps: 3, tools: 2, toolErrors: 1, startedAt: "2026-11-09T10:00:00Z", endedAt: "2026-11-09T10:00:02Z" }),
      row("qwen-local", { route: "quick", quickModel: "qwen-local", outcome: { status: "error" }, startedAt: "2026-11-09T10:00:00Z", endedAt: "2026-11-09T10:00:10Z" }),
      row("big-cloud", { route: "fallback", quickModel: "qwen-local", outcome: { status: "ok" }, costUsd: 0.02 }),
      row("big-cloud", { costUsd: 0.01 }),
    ];
    const [cloud, local] = modelPerformance(rows);
    expect(local).toMatchObject({ model: "qwen-local", turns: 2, ok: 1, ended: 2, steps: 3, tools: 2, toolErrors: 1, quickTurns: 3, fallbacks: 1, p50Ms: 10_000, p90Ms: 10_000 });
    expect(cloud).toMatchObject({ model: "big-cloud", turns: 2, ok: 1, ended: 1, quickTurns: 0, fallbacks: 0, p50Ms: null, input: 200, output: 100 });
    expect(cloud!.costUsd).toBeCloseTo(0.03);
    expect(quickFallbacks(rows)).toBe(1);
  });
});

describe("the training data routes", () => {
  function call(routes: ReturnType<typeof createTrainingDataRoutes>, method: string, path: string) {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const res = { setHeader: vi.fn() };
    return routes({ req: {} as never, res: res as never, url: new URL(`http://x${path}`), path, method, auth: {} as never,
      json: ((_res: unknown, status: number, body: Record<string, unknown>) => { out.status = status; out.body = body; }) as never, readBody: (async () => ({})) as never,
    } as RouteContext).then((passed) => ({ ...out, passed }));
  }

  it("sums up, exports every row as one file, and deletes them all", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-training-routes-"));
    dirs.push(dir);
    const log = new TrainingLog();
    log.configure({ dir, mode: () => "local" });
    log.step(log.capture([{ role: "user", content: "hi" }], []), { threadId: "t", turnId: "u1", round: 0, model: "m", driverKind: "x", local: false, safeText: (text) => text }, { text: "hello", toolCalls: [] });
    const routes = createTrainingDataRoutes({ log, uploader: { status: () => ({ shareSince: null, sentTurns: 0, refusedTurns: 0, lastSentAt: null, lastError: null, nextAttemptAt: null }) }, available: () => true });

    expect(await call(routes, "GET", "/api/training-data")).toMatchObject({ status: 200, body: { mode: "local", steps: 1, turns: 1, available: true, upload: { sentTurns: 0 } } });
    // The export streams the day files: through a real response, so the bytes are what a download gets.
    const server = createServer((req, res) => void routes({ req, res, url: new URL(`http://x${req.url}`), path: req.url!, method: req.method!, auth: {} as never,
      json: (() => {}) as never, readBody: (async () => ({})) as never } as RouteContext));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/training-data.jsonl`);
    server.close();
    expect(response.headers.get("content-disposition")).toContain("mausbot-training-data.jsonl");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; completion?: { content: string } });
    expect(lines).toEqual([expect.objectContaining({ kind: "step", completion: expect.objectContaining({ content: "hello" }) })]);
    expect(await call(routes, "DELETE", "/api/training-data")).toMatchObject({ status: 200, body: { ok: true, steps: 0 } });
    expect(log.days()).toEqual([]);
    expect((await call(routes, "POST", "/api/training-data")).passed).toBeDefined();
  });
});
