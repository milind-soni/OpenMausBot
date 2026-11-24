import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { workflowSchema } from "../../shared/skill-burger/format.ts";
import { createExecutors } from "./executors.ts";
import { createRunStates } from "./run-state.ts";
import { resumeRun, startRun, type RunDeps, type RunEnvelope } from "./runner.ts";
import { readWorkflowSkill, saveWorkflowSkill } from "./store.ts";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

async function savedRun(parts: string[], present: string[] = [], refuse = false) {
  const root = mkdtempSync(join(tmpdir(), "burger-skipped-delegation-"));
  roots.push(root);
  const workflow = workflowSchema.parse({
    version: 1, summary: "Prepare and finish the report", args: {}, steps: [
      { id: "s1", kind: "file", label: "Prepare the report", path: "prepared.txt", content: "prepared" },
      { id: "s2", kind: "delegate", label: "Ask for optional inspections", tasks: parts.map((name) => ({ bot: { id: name.toLowerCase(), name }, message: `Inspect ${name}'s part` })) },
      { id: "s3", kind: "file", label: "Keep the preparation result", path: "completed.txt", content: { $step: "s1" } },
    ],
  });
  const saved = saveWorkflowSkill({ root, name: "inspection", origin: "lead", botIds: ["lead"], workflow });
  if ("error" in saved) throw new Error(saved.error);
  const found = readWorkflowSkill("inspection", root)!;
  const stateDir = join(root, "states");
  const sent: Array<{ botIds: string[]; message: string }> = [];
  const assignments: string[] = [];
  const ended: Array<{ step: string; state: string }> = [];
  const deps: RunDeps = {
    exec: createExecutors({ botId: "lead", cwd: root, async internal(kind, path, body) {
      expect(kind).toBe("agents");
      if (path.startsWith("/api/internal/agents?")) return { ok: true, body: { bots: present.map((name) => ({ id: name.toLowerCase(), name })) } };
      if (path.startsWith("/api/internal/assignment-status?")) {
        assignments.push(path);
        return { ok: true, body: { assignment: { status: "completed", result: "The inspection is complete." } } };
      }
      expect(path).toBe("/api/internal/coordinate-bots");
      const call = body as { botIds: string[]; message: string };
      sent.push(call);
      return refuse ? { ok: false, status: 409, body: { error: "The hand-off was refused" } } : {
        ok: true, body: { receipts: call.botIds.map((botId) => ({ botId, botName: present.find((name) => name.toLowerCase() === botId), requestId: `request-${botId}` })) },
      };
    } }),
    events: { started() {}, ended: (_run, _name, step, result) => ended.push({ step: step.id, state: result.state }) },
    save: (state) => createRunStates(stateDir).save(state),
  };
  const first = await startRun({ name: "inspection", botId: "lead", threadId: "inspection-thread", sha256: saved.sha256, workflow: found.workflow }, deps);
  return {
    first, sent, assignments, ended,
    resume: (envelope: RunEnvelope, response: string) => {
      const state = createRunStates(stateDir).take(envelope.run, "lead");
      expect(state).not.toBeNull();
      return resumeRun(state!, response, deps);
    },
    completed: () => existsSync(join(root, "completed.txt")),
    contents: () => readFileSync(join(root, "completed.txt"), "utf8"),
  };
}

it.each([
  [["Kiwi"], "skip"],
  [["Kiwi", "Rio"], "Kiwi=skip, Rio=skip"],
] as const)("continues after the person leaves out every saved part: %j", async (parts, response) => {
  const h = await savedRun([...parts]);
  expect(h.first.requiresInput?.type).toBe("missing_bot");
  expect(h.first.requiresInput?.prompt).toContain('"skip"');
  expect(h.completed()).toBe(false);
  const done = await h.resume(h.first, response);
  expect(done).toMatchObject({ ok: true, status: "ok", steps: [
    { id: "s1", state: "done" }, { id: "s2", state: "skipped" }, { id: "s3", state: "done" },
  ] });
  expect(h.contents()).toBe("prepared.txt");
  expect(h.sent).toEqual([]);
  expect(h.assignments).toEqual([]);
  expect(h.ended.filter((event) => event.step === "s1")).toEqual([{ step: "s1", state: "done" }]);
  expect(h.ended.filter((event) => event.step === "s2")).toEqual([{ step: "s2", state: "skipped" }]);
});

it("still sends and waits for the part that the person kept", async () => {
  const h = await savedRun(["Kiwi", "Rio"], ["Kiwi"]);
  const waiting = await h.resume(h.first, "skip");
  expect(waiting.requiresInput?.type).toBe("teammates");
  expect(h.sent).toEqual([expect.objectContaining({ botIds: ["kiwi"] })]);
  expect(h.completed()).toBe(false);
  expect(await h.resume(waiting, "back")).toMatchObject({ ok: true, status: "ok" });
  expect(h.contents()).toBe("prepared.txt");
  expect(h.assignments).toHaveLength(1);
  expect(h.ended).toContainEqual({ step: "s2", state: "done" });
});

it("keeps an unresolved choice pending and does not call it skipped", async () => {
  const h = await savedRun(["Kiwi", "Rio"]);
  const waiting = await h.resume(h.first, "Kiwi=skip");
  expect(waiting.requiresInput?.type).toBe("missing_bot");
  expect(h.completed()).toBe(false);
  expect(h.sent).toEqual([]);
  expect(h.ended.some((event) => event.step === "s2")).toBe(false);
});

it("keeps an actual hand-off refusal as a resumable failure", async () => {
  const h = await savedRun(["Kiwi"], ["Kiwi"], true);
  expect(h.first).toMatchObject({ ok: false, error: { type: "step_failed", step: "s2", resumeToken: h.first.run } });
  expect(await h.resume(h.first, "try again")).toMatchObject({ ok: false, error: { type: "step_failed", step: "s2" } });
  expect(h.sent).toHaveLength(2);
  expect(h.completed()).toBe(false);
  expect(h.ended.some((event) => event.state === "skipped")).toBe(false);
});
