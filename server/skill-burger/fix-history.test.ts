// "Update the burger with this fix", a burger's run history, and the line that sends a resumed turn back into its run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import type { RunMessage } from "../../shared/skill-burger/layers.ts";
import { insertFix } from "./edit.ts";
import { createRunHistory } from "./history.ts";
import { createRunStates } from "./run-state.ts";
import { fillPrompt, type RunEnvelope, type RunState } from "./runner.ts";
import { fixLayers } from "./routes.ts";

const wf = (steps: unknown[]): Workflow => workflowSchema.parse({ version: 1, summary: "Make the csv", args: {}, steps });
let n = 0;
const bash = (command: string): RunMessage => ({ id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "Bash", ok: true, itemId: `t${n}`, input: JSON.stringify({ command }), summary: command } });
const runCall = (output: string): RunMessage => ({ id: `m${++n}`, role: "bot", kind: "activity", tool: { name: "mcp__agents__run_workflow", ok: true, itemId: `t${n}`, input: "{}", output } });

describe("keeping a fix", () => {
  it("takes what the bot did between the failed step and going on, and puts it just before that step", () => {
    const messages = [
      { id: "u", role: "user", kind: "text", text: "/make-csv" },
      runCall('The Skill Burger stopped: "Convert" failed: in2csv: command not found. Once the cause is fixed, call run_workflow with resume "run-1"'),
      bash("python3 -m venv .venv && .venv/bin/pip install csvkit"),
      bash(".venv/bin/in2csv a.json > done.csv"),
      runCall("The Skill Burger ran: …"),
    ] as RunMessage[];
    const layers = fixLayers(messages, "run-1");
    expect(layers.map((layer) => layer.kind)).toEqual(["shell", "shell"]);
    const workflow = wf([
      { id: "s1", kind: "shell", label: "Fetch", run: "curl -s https://example.com/a.json -o a.json" },
      { id: "s2", kind: "shell", label: "Convert", run: "in2csv a.json > done.csv" },
      { id: "s3", kind: "shell", label: "Archive", run: "cp done.csv archive/", stdin: { $step: "s2" } },
    ]);
    // Going on from the failed step ran it again and it worked: the fix goes before it, and the step stays.
    const fixed = insertFix(workflow, "s2", [
      { id: "s1", kind: "shell", label: "Install csvkit", run: "python3 -m venv .venv && .venv/bin/pip install csvkit" },
      { id: "s2", kind: "shell", label: "Put it on PATH", run: "ln -sf .venv/bin/in2csv ./in2csv", stdin: { $step: "s1" } },
    ]) as Workflow;
    expect(fixed.steps.map((step) => step.id)).toEqual(["s1", "s2_fix1", "s2_fix2", "s2", "s3"]);
    expect(fixed.steps[2]).toMatchObject({ stdin: { $step: "s2_fix1" } });
    expect(fixed.steps[4]).toMatchObject({ stdin: { $step: "s2" } });
    expect(workflowSchema.safeParse(fixed).success).toBe(true);
  });

  it("finds nothing when the run never stopped", () => {
    expect(fixLayers([runCall("The Skill Burger ran: …"), bash("echo hi > a.txt")], "run-1")).toEqual([]);
  });
});

describe("a burger's run history", () => {
  const envelope = (run: string, extra: Partial<RunEnvelope>): RunEnvelope => ({ protocolVersion: 1, ok: true, run, steps: [{ id: "s1", label: "Convert", state: "done" }], ...extra });

  it("keeps each run once, newest first, with where a failed one stopped and the saved inputs it reused", () => {
    let now = 1_000;
    const history = createRunHistory(mkdtempSync(join(tmpdir(), "burger-history-")), () => now);
    const where = { name: "make-csv", botId: "b1", threadId: "t1" };
    history.record(where, envelope("r1", { ok: false, error: { type: "step_failed", message: '"Convert" failed: no in2csv', step: "s1", resumeToken: "r1" }, defaults: [{ name: "url", value: "https://a.example" }] }));
    now = 2_000;
    history.record(where, envelope("r1", { status: "ok" }));
    now = 3_000;
    history.record({ ...where, threadId: "t2" }, envelope("r2", { status: "needs_input" }));
    const runs = history.list("make-csv");
    expect(runs.map((run) => [run.run, run.status])).toEqual([["r2", "waiting"], ["r1", "ok"]]);
    expect(runs[1]).toMatchObject({ defaults: ["url"], fixedBy: "s1", startedAt: 1_000, at: 2_000 });
    expect(history.list("make-csv", new Set(["someone-else"]))).toEqual([]);
  });
});

describe("a turn resumed by teammates' replies", () => {
  it("finds the run in that chat waiting on them, and nothing elsewhere", () => {
    const states = createRunStates(mkdtempSync(join(tmpdir(), "burger-states-")));
    const state = {
      id: "0d5c3a52-9a2e-4b55-8f1e-1d4c6f7a8b9c", name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: wf([{ id: "s1", kind: "shell", label: "x", run: "true" }]), args: {}, results: {},
      waiting: { step: "s1", type: "teammates" }, delegation: { step: "s1", round: 1, who: {}, replies: {}, requests: [{ part: "Kiwi", botId: "kiwi", name: "Kiwi", requestId: "h-1" }] }, createdAt: Date.now(),
    } as RunState;
    states.save(state);
    expect(states.waitingIn("t1", ["h-1", "h-9"])?.id).toBe(state.id);
    // Replies to other hand-offs in the same chat are not this run's.
    expect(states.waitingIn("t1", ["h-9"])).toBeNull();
    expect(states.waitingIn("t2", ["h-1"])).toBeNull();
    expect(fillPrompt("Review what came back for {site} ({other})", { site: "https://example.org" })).toBe("Review what came back for https://example.org ({other})");
  });
});
