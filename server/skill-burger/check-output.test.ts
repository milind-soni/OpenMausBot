import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createExecutors, type ExecutorContext } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function rig(steps: unknown[], internal: ExecutorContext["internal"] = async () => ({ ok: false, body: {} })) {
  const cwd = mkdtempSync(join(tmpdir(), "burger-check-"));
  folders.push(cwd);
  const root = join(cwd, "skills");
  const saved = saveWorkflowSkill({ workflow: { version: 1, summary: "Review and keep the report", args: {}, steps }, botIds: [], root });
  if ("error" in saved) throw new Error(saved.error);
  const workflow = readWorkflowSkill(saved.name, root)!.workflow;
  const states = createRunStates(join(cwd, "runs"));
  const deps: RunDeps = {
    exec: createExecutors({ botId: "reviewer", cwd, internal }),
    events: { started: () => {}, ended: () => {} },
    save: (state) => states.save(state),
  };
  return {
    cwd, states, deps,
    start: () => startRun({ name: saved.name, botId: "reviewer", threadId: "report", sha256: saved.sha256, workflow }, deps),
  };
}

it.each([true, { says: "the report is ready to archive" }])("keeps a checked file result through persisted resume (%j)", async (check) => {
  const h = rig([
    { id: "report", kind: "file", label: "Write report", path: "report.txt", content: "Quarterly report", check },
    { id: "manifest", kind: "file", label: "Keep report path", path: "manifest.txt", content: { $step: "report" } },
  ]);
  const paused = await h.start();
  expect(paused.requiresInput).toMatchObject({ type: "check", step: "report", input: "report.txt" });
  expect(readFileSync(join(h.cwd, "report.txt"), "utf8")).toBe("Quarterly report");
  expect(existsSync(join(h.cwd, "manifest.txt"))).toBe(false);
  const state = h.states.take(paused.run, "reviewer")!;
  const outputAtPause = state.results.report;
  const done = await resumeRun(state, "pass", h.deps);
  expect(done).toMatchObject({ status: "ok", steps: [{ id: "report", state: "done" }, { id: "manifest", state: "done" }] });
  expect(readFileSync(join(h.cwd, "manifest.txt"), "utf8")).toBe("report.txt");
  expect(outputAtPause).toMatchObject({ state: "handed", output: "report.txt" });
});

it.each(["pass", "fail: wrong recipient"])("preserves checked app data for a later file only after a passing review (%s)", async (verdict) => {
  const calls: unknown[] = [];
  const h = rig([
    { id: "draft", kind: "app", app: "gmail", tool: "gmail.create_draft", label: "Create draft", args: { to: "priya@example.com", subject: "Weekly report", body: "Ready for review" }, check: { says: "the recipient and subject are right" } },
    { id: "receipt", kind: "file", label: "Keep draft ID", path: "draft-id.txt", content: { $step: "draft", path: "id" } },
  ], async (_kind, _path, body) => {
    calls.push(body);
    return { ok: true, body: { result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { id: "draft-current", message: { threadId: "thread-current" } } }) }] } } };
  });
  const paused = await h.start();
  expect(paused.requiresInput).toMatchObject({ type: "check", step: "draft", input: '{"id":"draft-current","message":{"threadId":"thread-current"}}' });
  expect(existsSync(join(h.cwd, "draft-id.txt"))).toBe(false);
  const done = await resumeRun(h.states.take(paused.run, "reviewer")!, verdict, h.deps);
  expect(calls).toHaveLength(1);
  if (verdict === "pass") {
    expect(done).toMatchObject({ ok: true, status: "ok" });
    expect(readFileSync(join(h.cwd, "draft-id.txt"), "utf8")).toBe("draft-current");
  } else {
    expect(done).toMatchObject({ ok: false, error: { type: "step_failed", step: "draft" } });
    expect(existsSync(join(h.cwd, "draft-id.txt"))).toBe(false);
  }
});
