import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { onCase, workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import { createRunStates } from "./run-state.ts";
import { argEnv, resolve, resumeRun, runArgs, startRun, type ExecResult, type RunDeps, type RunState, type StepExecutors } from "./runner.ts";

const app = (id: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, kind: "app" as const, app: tool.split("_")[0]!.toLowerCase(), tool, label: tool, args, ...extra });
const wf = (steps: unknown[], args: Workflow["args"] = {}): Workflow => {
  const checked = workflowSchema.safeParse({ version: 1, summary: "Test burger", args, steps });
  if (!checked.success) throw new Error(checked.error.message);
  return checked.data;
};

function harness(handlers: Partial<StepExecutors> = {}) {
  const calls: Array<{ kind: string; input: unknown }> = [];
  const events: string[] = [];
  const saved: RunState[] = [];
  const ok = (output: unknown): Promise<ExecResult> => Promise.resolve({ ok: true, output });
  const exec: StepExecutors = {
    shell: handlers.shell ?? ((input) => { calls.push({ kind: "shell", input }); return ok(""); }),
    app: handlers.app ?? ((input) => { calls.push({ kind: "app", input }); return ok({}); }),
    browser: handlers.browser ?? ((input) => { calls.push({ kind: "browser", input }); return ok("opened"); }),
    file: handlers.file ?? ((input) => { calls.push({ kind: "file", input }); return ok("written"); }),
  };
  const deps: RunDeps = {
    exec,
    events: { started: (_run, _name, step) => events.push(`start ${step.id}`), ended: (_run, _name, step, result) => events.push(`${result.state} ${step.id}`) },
    save: (state) => saved.push(structuredClone(state)),
  };
  const start = (workflow: Workflow, args?: Record<string, unknown>) => startRun({ name: "test-burger", botId: "bot-1", threadId: "t1", sha256: "x", workflow, ...(args ? { args } : {}) }, deps);
  return { calls, events, saved, deps, start };
}

describe("running a Skill Burger", () => {
  it("runs each step where it ran, pipes values forward and fills args, with OMB_ARG_ env for commands", async () => {
    const h = harness({
      app: async (input) => {
        h.calls.push({ kind: "app", input });
        return input.tool === "GMAIL_FETCH_EMAILS" ? { ok: true, output: { messages: [{ id: "m-42" }] } } : { ok: true, output: { sent: true } };
      },
    });
    const workflow = wf([
      app("s1", "GMAIL_FETCH_EMAILS", { query: { $arg: "query" } }),
      app("s2", "GMAIL_FORWARD_MESSAGE", { message_id: { $step: "s1", path: "messages.0.id" }, to: { $arg: "to" } }),
      { id: "s3", kind: "shell", label: "Archive", run: 'echo "$OMB_ARG_TO"', where: "vm" },
    ], { query: { default: "invoice" }, to: { default: "a@example.com" } });
    const result = await h.start(workflow, { to: "priya@example.com", nope: "ignored" });
    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(h.calls.map((call) => call.kind)).toEqual(["app", "app", "shell"]);
    expect(h.calls[0]!.input).toMatchObject({ tool: "GMAIL_FETCH_EMAILS", args: { query: "invoice" } });
    expect(h.calls[1]!.input).toMatchObject({ args: { message_id: "m-42", to: "priya@example.com" } });
    expect(h.calls[2]!.input).toMatchObject({ command: 'echo "$OMB_ARG_TO"', where: "vm", env: { OMB_ARG_QUERY: "invoice", OMB_ARG_TO: "priya@example.com" } });
    expect(h.events).toEqual(["start s1", "done s1", "start s2", "done s2", "start s3", "done s3"]);
  });

  it("stops at the first failure, names the step, and runs nothing after it", async () => {
    const h = harness({ app: async () => ({ ok: false, error: "403 the sheet is not shared with you" }) });
    const result = await h.start(wf([app("s1", "GOOGLESHEETS_BATCH_GET", {}), { id: "s2", kind: "file", label: "Write notes", path: "n.md", content: "x" }]));
    expect(result).toMatchObject({ ok: false, error: { type: "step_failed", step: "s1" } });
    expect(result.error!.message).toContain("403 the sheet is not shared with you");
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual(["start s1", "failed s1"]);
  });

  it("stops a step past its time limit, and a step whose output is too large", async () => {
    vi.useFakeTimers();
    try {
      const slow = harness({ shell: (input) => new Promise((done) => input.signal.addEventListener("abort", () => done({ ok: false, error: "killed" }))) });
      const running = slow.start(wf([{ id: "s1", kind: "shell", label: "Slow", run: "sleep 999", timeoutMs: 2_000 }]));
      await vi.advanceTimersByTimeAsync(2_001);
      expect(await running).toMatchObject({ ok: false, error: { type: "timeout", step: "s1" } });
    } finally {
      vi.useRealTimers();
    }
    const big = harness({ shell: async () => ({ ok: false, error: "output went over 512 KB", tooLarge: true }) });
    expect(await big.start(wf([{ id: "s1", kind: "shell", label: "Big", run: "yes" }]))).toMatchObject({ ok: false, error: { type: "output_too_large" } });
  });

  it("hands an AI step to the bot with its piped input, marked as judgement, then goes on once it answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "burger-runs-"));
    const states = createRunStates(dir);
    const h = harness({ app: async (input) => { h.calls.push({ kind: "app", input }); return { ok: true, output: { rows: [["West", 40]] } }; } });
    h.deps.save = (state) => states.save(state);
    const workflow = wf([
      app("s1", "GOOGLESHEETS_BATCH_GET", {}),
      { id: "s2", kind: "ai", deterministic: false, label: "Write the body", prompt: "Write a short summary.", input: { $step: "s1" }, example: "Revenue is up." },
      app("s3", "GMAIL_SEND_EMAIL", { body: { $step: "s2" } }),
    ]);
    const paused = await h.start(workflow);
    expect(paused).toMatchObject({ ok: true, status: "needs_input", requiresInput: { type: "ai_step", step: "s2", example: "Revenue is up." } });
    expect(paused.requiresInput!.input).toBe('{"rows":[["West",40]]}');
    const token = paused.requiresInput!.resumeToken;
    expect(states.take(token, "another-bot")).toBeNull();
    const state = states.take(token, "bot-1")!;
    expect(states.take(token, "bot-1")).toBeNull();
    const done = await resumeRun(state, "West sold 40.", h.deps);
    expect(done).toMatchObject({ ok: true, status: "ok" });
    expect(h.calls[1]!.input).toMatchObject({ tool: "GMAIL_SEND_EMAIL", args: { body: "West sold 40." } });
  });

  it("skips a step whose condition doesn't hold", async () => {
    const h = harness({ app: async (input) => { h.calls.push({ kind: "app", input }); return { ok: true, output: { messages: [] } }; } });
    const result = await h.start(wf([
      app("s1", "GMAIL_FETCH_EMAILS", {}),
      app("s2", "GMAIL_SEND_EMAIL", {}, { when: { $step: "s1", path: "messages.0", op: "exists" } }),
    ]));
    expect(result).toMatchObject({ ok: true, status: "ok", steps: [{ id: "s1", state: "done" }, { id: "s2", state: "skipped" }] });
    expect(h.calls).toHaveLength(1);
  });
});

describe("connections", () => {
  it("asks for an app the bot isn't connected to before any step runs", async () => {
    const h = harness();
    h.deps.exec.connected = async () => ["slack"];
    const workflow = wf([{ id: "s1", kind: "shell", label: "Stage", run: "git add a.md" }, app("s2", "GMAIL_SEND_EMAIL", { to: "a@example.com" }), app("s3", "SLACK_SEND_MESSAGE", { text: "hi" })]);
    const result = await h.start(workflow);
    expect(result).toMatchObject({ ok: false, error: { type: "needs_connection", apps: ["gmail"] } });
    expect(result.error!.message).toContain("Gmail");
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
    // Connected, or not known: it runs.
    h.deps.exec.connected = async () => ["gmail", "slack"];
    expect((await h.start(workflow)).status).toBe("ok");
    h.deps.exec.connected = async () => null;
    expect((await h.start(workflow)).status).toBe("ok");
  });
});

describe("cases", () => {
  const forked = (rules = true) => wf([
    app("s1", "GMAIL_FETCH_EMAILS", {}),
    {
      id: "d1", kind: "decide", label: "What kind of email", cases: ["support", "sales", "other"],
      ...(rules ? { rules: [{ $step: "s1", path: "label", op: "eq", value: "help", case: "support" }, { $step: "s1", path: "label", op: "eq", value: "buy", case: "sales" }], otherwise: "other" } : { prompt: "Is this support or sales?", input: { $step: "s1" } }),
    },
    { ...app("s2", "LINEAR_CREATE_ISSUE", {}), when: onCase("d1", "support") },
    { ...app("s3", "HUBSPOT_CREATE_DEAL", {}), when: onCase("d1", "sales") },
    app("s4", "SLACK_SEND_MESSAGE", {}),
  ]);

  it("takes only the chosen case's steps by rule, and marks the others not taken", async () => {
    const h = harness({ app: async (input) => { h.calls.push({ kind: "app", input }); return { ok: true, output: input.tool === "GMAIL_FETCH_EMAILS" ? { label: "help" } : {} }; } });
    const result = await h.start(forked());
    expect(result.steps).toEqual([
      { id: "s1", label: "GMAIL_FETCH_EMAILS", state: "done" },
      { id: "d1", label: "What kind of email", state: "done", case: "support" },
      { id: "s2", label: "LINEAR_CREATE_ISSUE", state: "done" },
      { id: "s3", label: "HUBSPOT_CREATE_DEAL", state: "not_taken" },
      { id: "s4", label: "SLACK_SEND_MESSAGE", state: "done" },
    ]);
    expect(h.calls.map((call) => (call.input as { tool: string }).tool)).toEqual(["GMAIL_FETCH_EMAILS", "LINEAR_CREATE_ISSUE", "SLACK_SEND_MESSAGE"]);
  });

  it("asks the bot to decide when the case needs judgement, refusing an answer that isn't a case", async () => {
    const h = harness({ app: async (input) => { h.calls.push({ kind: "app", input }); return { ok: true, output: { subject: "Can I buy 10 seats?" } }; } });
    const paused = await h.start(forked(false));
    expect(paused.requiresInput).toMatchObject({ type: "decide", step: "d1", cases: ["support", "sales", "other"], input: '{"subject":"Can I buy 10 seats?"}' });
    const state = h.saved.at(-1)!;
    expect(await resumeRun(structuredClone(state), "maybe", h.deps)).toMatchObject({ ok: false });
    const done = await resumeRun(structuredClone(state), "Sales", h.deps);
    expect(done).toMatchObject({ ok: true, status: "ok" });
    expect(h.calls.map((call) => (call.input as { tool: string }).tool)).toEqual(["GMAIL_FETCH_EMAILS", "HUBSPOT_CREATE_DEAL", "SLACK_SEND_MESSAGE"]);
  });

  it("hands a case with no saved steps to the bot, then goes on with the rest", async () => {
    const h = harness({ app: async (input) => { h.calls.push({ kind: "app", input }); return { ok: true, output: input.tool === "GMAIL_FETCH_EMAILS" ? { label: "spam" } : {} }; } });
    const paused = await h.start(forked());
    expect(paused.requiresInput).toMatchObject({ type: "missing_case", step: "d1" });
    expect(paused.requiresInput!.prompt).toContain('"other" case');
    const done = await resumeRun(h.saved.at(-1)!, "Marked it as spam.", h.deps);
    expect(done).toMatchObject({ ok: true, status: "ok" });
    expect(h.calls.map((call) => (call.input as { tool: string }).tool)).toEqual(["GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE"]);
  });

  it("refuses a step tagged with a case its decide step doesn't have", () => {
    expect(workflowSchema.safeParse({ version: 1, summary: "x", args: {}, steps: [
      { id: "d1", kind: "decide", label: "Kind", cases: ["a"], prompt: "Which?" },
      { ...app("s1", "SLACK_SEND_MESSAGE", {}), when: onCase("d1", "b") },
    ] }).success).toBe(false);
  });
});

it("fills args from defaults and the request, and passes them to commands only through the environment", () => {
  const workflow = wf([{ id: "s1", kind: "shell", label: "x", run: "true" }], { to: { default: "a" }, n: {} });
  expect(runArgs(workflow, { to: "b", other: 1 })).toEqual({ to: "b" });
  expect(argEnv({ to: "b", n: 3 })).toEqual({ OMB_ARG_TO: "b", OMB_ARG_N: "3" });
  expect(resolve({ a: [{ $arg: "to" }, { $step: "s1", path: "x.0" }] }, { to: "b" }, { s1: { state: "done", output: { x: ["y"] } } })).toEqual({ a: ["b", "y"] });
});
