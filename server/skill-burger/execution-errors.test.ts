import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { createExecutors, type ExecutorContext } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";

const folders: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function rig(internal: ExecutorContext["internal"], signal?: AbortSignal) {
  const cwd = mkdtempSync(join(tmpdir(), "burger-execution-error-"));
  folders.push(cwd);
  const states = createRunStates(join(cwd, "runs"));
  const deps: RunDeps = {
    exec: createExecutors({ botId: "reporter", cwd, internal }),
    events: { started: () => {}, ended: () => {} },
    save: (state) => states.save(state),
    ...(signal ? { signal } : {}),
  };
  const start = (steps: unknown[]) => startRun({ name: "report", botId: "reporter", threadId: "weekly", sha256: "fixture", workflow: workflowSchema.parse({ version: 1, summary: "Make a report", args: {}, steps }) }, deps);
  return { cwd, states, deps, start };
}

const draft = { id: "draft", kind: "app", app: "gmail", tool: "gmail.create_draft", label: "Create draft", args: { to: "priya@example.com", subject: "Report", body: "Ready" } };
const done = { id: "done", kind: "file", label: "Finish report", path: "done.txt", content: "finished" };

it.each(["directory target", "file parent"])("persists a thrown file error and resumes without recreating the draft (%s)", async (failure) => {
  const calls: unknown[] = [];
  const h = rig(async (_kind, _path, body) => {
    calls.push(body);
    return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { id: "draft-current" } }) }] } } };
  });
  const obstruction = join(h.cwd, failure === "directory target" ? "draft-id.txt" : "reports");
  if (failure === "directory target") mkdirSync(obstruction);
  else writeFileSync(obstruction, "a file occupies the report directory");
  const path = failure === "directory target" ? "draft-id.txt" : "reports/draft-id.txt";
  const failed = await h.start([draft, { id: "receipt", kind: "file", label: "Keep draft ID", path, content: { $step: "draft", path: "id" } }, done]);
  expect(failed).toMatchObject({ ok: false, error: { type: "step_failed", step: "receipt", resumeToken: failed.run } });
  expect(failed.error!.message).toContain("Keep draft ID");
  expect(calls).toHaveLength(1);
  expect(existsSync(join(h.cwd, "done.txt"))).toBe(false);
  const state = h.states.take(failed.run, "reporter")!;
  expect(state.waiting).toEqual({ step: "receipt", type: "failed" });
  expect(state.results.draft).toMatchObject({ state: "done", output: { id: "draft-current" } });

  rmSync(obstruction, { recursive: true });
  expect(await resumeRun(state, "fixed the path", h.deps)).toMatchObject({ ok: true, status: "ok" });
  expect(calls).toHaveLength(1);
  expect(readFileSync(join(h.cwd, path), "utf8")).toBe("draft-current");
  expect(readFileSync(join(h.cwd, "done.txt"), "utf8")).toBe("finished");
});

it.each([true, false])("keeps an interrupted executor cancellation separate from failure (throws=%s)", async (throws) => {
  const controller = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const h = rig(async (_kind, _path, _body, signal) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      if (throws) reject(new DOMException("Stopped", "AbortError"));
      else resolve({ ok: false, body: { error: "Stopped" } });
    }, { once: true });
    started();
  }), controller.signal);
  const running = h.start([draft, done]);
  await entered;
  controller.abort();
  const cancelled = await running;
  expect(cancelled).toMatchObject({ ok: true, status: "cancelled" });
  expect(cancelled.error).toBeUndefined();
  expect(h.states.take(cancelled.run, "reporter")).toBeNull();
  expect(existsSync(join(h.cwd, "done.txt"))).toBe(false);
});

it("still reports a timeout when the executor rejects as its deadline aborts it", async () => {
  vi.useFakeTimers();
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const h = rig(async (_kind, _path, _body, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Deadline", "AbortError")), { once: true });
    started();
  }));
  const running = h.start([{ ...draft, timeoutMs: 1_000 }, done]);
  await entered;
  await vi.advanceTimersByTimeAsync(1_001);
  const failed = await running;
  expect(failed).toMatchObject({ ok: false, error: { type: "timeout", step: "draft", resumeToken: failed.run } });
  expect(h.states.take(failed.run, "reporter")!.waiting).toEqual({ step: "draft", type: "failed" });
  expect(existsSync(join(h.cwd, "done.txt"))).toBe(false);
});
