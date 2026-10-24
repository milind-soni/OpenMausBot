import { mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUsageRoutes, type UsageRouteDeps } from "./usage.ts";
import { PASS, type RouteContext } from "./table.ts";
import type { Assignment } from "../runtime/types.ts";
import { removeTempDir } from "../testing/cleanup.ts";

describe("thread-scoped job usage route", () => {
  const directories: string[] = [];
  afterEach(async () => { await Promise.all(directories.splice(0).map(removeTempDir)); });
  const run = async (path: string, jobs: UsageRouteDeps["jobs"]) => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-job-usage-route-")); directories.push(dataDir);
    const json = vi.fn();
    const setHeader = vi.fn();
    const auth = { kind: "loopback", scopes: ["admin", "client"] } as RouteContext["auth"];
    const out = await createUsageRoutes({
      dataDir, prices: () => null, budget: () => null, currency: () => "USD", jobs,
      recorder: { append() {}, drain: async () => {} } as unknown as UsageRouteDeps["recorder"],
      messages: () => [], liveBot: () => null, canSee: () => () => true,
    })({
      path: path.split("?")[0], url: new URL(path, "http://127.0.0.1"), method: "GET", auth,
      res: { setHeader } as unknown as ServerResponse, json: json as RouteContext["json"],
    } as RouteContext);
    return { out, json, setHeader, auth };
  };

  it("passes thread identity, timestamp and request authorization to the existing visibility gate", async () => {
    const jobs = vi.fn(() => ({ scopes: [], rows: [] }));
    const result = await run("/api/threads/office/job/usage?since=12", jobs);
    expect(jobs).toHaveBeenCalledWith("office", 12, result.auth);
    expect(result.json).toHaveBeenCalledWith(expect.anything(), 200, { scopes: [], jobs: [] });
    expect(result.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
  });

  it("returns no usage when the existing visibility gate refuses a thread", async () => {
    const result = await run("/api/threads/other/job/usage", () => undefined);
    expect(result.json).toHaveBeenCalledWith(expect.anything(), 404, { error: "Thread not found" });
  });

  it("does not accept a root outside the authorized thread rows", async () => {
    const result = await run("/api/threads/office/job/usage?rootId=secret", () => ({ scopes: [], rows: [] }));
    expect(result.json).toHaveBeenCalledWith(expect.anything(), 404, { error: "Job not found in this thread" });
  });

  it.each(["-1", "NaN", "Infinity", "0.5", "9007199254740992"])("rejects invalid since=%s before visibility lookup", async since => {
    const jobs = vi.fn(() => ({ scopes: [], rows: [] }));
    const result = await run(`/api/threads/office/job/usage?since=${since}`, jobs);
    expect(result.json.mock.calls[0]?.[1]).toBe(400);
    expect(jobs).not.toHaveBeenCalled();
  });

  it("returns native roots with truthful missing legacy coverage", async () => {
    const row = { id: "root", rootId: "root", executions: 1, status: "failed", createdAt: Date.now(), assignee: { botId: "b", destination: { threadId: "office" } } } as Assignment;
    const result = await run("/api/threads/office/job/usage?rootId=root", () => ({ scopes: ["root"], rows: [row] }));
    expect(result.json.mock.calls[0]?.[2]).toMatchObject({ scopes: ["root"], jobs: [{ rootId: "root", coverage: { state: "partial", missingAttempts: 1 } }] });
  });

  it("declines the route until the native authorization integration is supplied", async () => {
    expect((await run("/api/threads/office/job/usage", undefined)).out).toBe(PASS);
  });

  it("keeps withheld descendant coverage partial without exposing its identity", async () => {
    const row = { id: "root", rootId: "root", executions: 0, status: "completed", createdAt: Date.now(), assignee: { botId: "b", destination: { threadId: "office" } } } as Assignment;
    const result = await run("/api/threads/office/job/usage", () => ({ scopes: ["root"], rows: [row], incompleteRoots: ["root"] }));
    expect(result.json.mock.calls[0]?.[2]).toMatchObject({ jobs: [{ assignments: 1, coverage: { state: "partial", scopeComplete: false, tokens: "partial", costs: "partial" } }] });
  });
});
