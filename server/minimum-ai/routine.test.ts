import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoutineManager } from "../routines.ts";
import { loadRoutine, loadRun } from "../routine-load.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
it("runs a minimum-AI automation through the workflow path without starting a model turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-routine-")); dirs.push(dir);
  const startTurn = vi.fn(async () => {});
  const runWorkflow = vi.fn(async () => ({ status: "completed" as const, output: "Checked sample data" }));
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread-1" }), startTurn, runWorkflow });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false });
  manager.runNow(routine.id);
  await manager.tick();
  await vi.waitFor(() => expect(manager.listRuns()[0]?.status).toBe("completed"));
  expect(runWorkflow).toHaveBeenCalledOnce();
  expect(startTurn).not.toHaveBeenCalled();
  expect(manager.listRuns()[0]?.output).toBe("Checked sample data");
});
it("stops and records a failed workflow without retrying or calling AI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-routine-")); dirs.push(dir);
  const startTurn = vi.fn(async () => {});
  const runWorkflow = vi.fn(async () => ({ status: "failed" as const, error: "Connection unavailable" }));
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread-1" }), startTurn, runWorkflow });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false });
  manager.runNow(routine.id);
  await manager.tick();
  await vi.waitFor(() => expect(manager.listRuns()[0]?.status).toBe("failed"));
  await manager.tick();
  expect(runWorkflow).toHaveBeenCalledOnce();
  expect(startTurn).not.toHaveBeenCalled();
  expect(manager.listRuns()[0]?.error).toContain("Connection unavailable");
});
it("pauses an enabled minimum-AI automation when a run fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-pause-")); dirs.push(dir);
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread" }), startTurn: vi.fn(async () => {}), runWorkflow: async () => ({ status: "failed", error: "Unavailable" }) });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 }, executionMode: "minimum-ai", enabled: true });
  manager.runNow(routine.id);
  await manager.tick();
  await vi.waitFor(() => expect(manager.listRuns()[0]?.status).toBe("failed"));
  expect(manager.listRoutines().find((item) => item.id === routine.id)).toMatchObject({ enabled: false, nextRunAt: null });
});
it("cancelling a running workflow aborts it instead of leaving tool calls running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-routine-")); dirs.push(dir);
  let signal: AbortSignal | undefined;
  const runWorkflow = vi.fn(async (_run: unknown, s: AbortSignal) => { signal = s; await new Promise<void>((resolve) => s.addEventListener("abort", () => resolve(), { once: true })); return { status: "failed" as const, error: "Cancelled" }; });
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread-1" }), startTurn: vi.fn(async () => {}), runWorkflow });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false });
  const run = manager.runNow(routine.id)!;
  await manager.tick();
  await manager.cancelRun(run.id);
  expect(signal?.aborted).toBe(true);
  expect(manager.listRuns()[0]?.status).toBe("cancelled");
});
it("aborts a workflow when its run limit is reached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-timeout-")); dirs.push(dir);
  let now = Date.now(), signal: AbortSignal | undefined;
  const manager = new RoutineManager({ file: join(dir, "routines.json"), now: () => now, botState: () => "ready", createTask: () => ({ threadId: "thread" }), startTurn: vi.fn(async () => {}), runWorkflow: async (_run, current) => { signal = current; await new Promise<void>((resolve) => current.addEventListener("abort", () => resolve(), { once: true })); return { status: "failed", error: "Cancelled" }; } });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: now + 60_000 }, timeoutMinutes: 5, executionMode: "minimum-ai", enabled: false });
  manager.runNow(routine.id);
  await manager.tick();
  now += 300_001;
  await manager.tick();
  expect(signal?.aborted).toBe(true);
  expect(manager.listRuns()[0]?.status).toBe("failed");
});
it("never falls back to an AI run for an unknown saved execution mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-invalid-")); dirs.push(dir);
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread" }), startTurn: vi.fn(async () => {}) });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: Date.now() + 60_000 }, enabled: false });
  const run = manager.runNow(routine.id)!;
  expect(loadRoutine({ ...routine, executionMode: "unknown" as never }, Date.now())).toBeNull();
  expect(loadRun({ ...run, executionMode: "unknown" as never })).toMatchObject({ status: "failed", error: "Invalid automation execution mode" });
});
it("keeps the selected mode on unrelated edits and can explicitly switch it off", () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-min-ai-edit-")); dirs.push(dir);
  const manager = new RoutineManager({ file: join(dir, "routines.json"), botState: () => "ready", createTask: () => ({ threadId: "thread" }), startTurn: vi.fn(async () => {}) });
  const routine = manager.create({ name: "Check", prompt: "Check data", botId: "bot", schedule: { type: "once", at: Date.now() + 60_000 }, executionMode: "minimum-ai", enabled: false });
  expect(manager.update(routine.id, { name: "Renamed" })?.executionMode).toBe("minimum-ai");
  expect(manager.update(routine.id, { executionMode: null })?.executionMode).toBeUndefined();
});
