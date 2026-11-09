import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RouteContext } from "../routes/table.ts";
import { createMinimumAiHost } from "./host.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
it("records, reviews, approves and replays a browser workflow without another model call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-browser-host-")); folders.push(dir);
  const routine = { id: "routine-1", name: "Sample", botId: "bot", prompt: "Run sample", executionMode: "minimum-ai", target: "bot", runOn: "maus", enabled: false } as const;
  const firstRun = vi.fn(async () => [{ kind: "open" as const, url: "https://example.test/" }, { origin: "https://example.test", url: "https://example.test/", role: "button", name: "Run" }]);
  const perform = vi.fn(async () => undefined);
  const host = createMinimumAiHost({ dataDir: dir, owner: (auth) => auth.kind === "session", routine: (id) => id === routine.id ? routine as never : undefined,
    services: async () => ({}), permitted: () => false, serviceFor: () => null, planner: () => async () => { throw new Error("unexpected model"); }, withRelay: async () => { throw new Error("unexpected connector"); },
    browser: { binding: async () => ["browser:profile-1"], firstRun, withSession: async (_routine, _thread, work) => work(perform) } });
  async function request(action: string, body: unknown = {}, kind = "session") {
    let response: { status: number; body: any } | undefined;
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writableEnded: false });
    await host.routes({ path: `/api/routines/routine-1/minimum-ai${action ? `/${action}` : ""}`, method: action ? "POST" : "GET", auth: { kind }, res, readBody: async () => body, json: (_res: unknown, status: number, value: unknown) => { response = { status, body: value }; } } as unknown as RouteContext);
    return response!;
  }
  expect((await request("record", {}, "other")).status).toBe(404);
  const recorded = await request("record", { confirm: true });
  expect(recorded.status).toBe(200);
  expect(recorded.body.workflow).toMatchObject({ verified: true, approved: false });
  expect(firstRun).toHaveBeenCalledOnce();
  expect((await request("")).body.workflow.fingerprint).toBe(recorded.body.workflow.fingerprint);
  expect((await request("approve", { fingerprint: recorded.body.workflow.fingerprint })).body.workflow.approved).toBe(true);
  expect(await host.canEnable({ kind: "session" } as never, routine.id)).toBe(true);
  const result = await host.runWorkflow({ id: "run-1", routineId: routine.id, botId: routine.botId, prompt: routine.prompt, threadId: "thread-1" } as never, new AbortController().signal);
  expect(result.status).toBe("completed");
  expect(perform).toHaveBeenCalledTimes(2);
  expect(firstRun).toHaveBeenCalledOnce();
});
