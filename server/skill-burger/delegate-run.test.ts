// A saved delegation run against a fake coordinator: the parts go out at once through coordinate_bots, the run pauses
// for the replies, a reply that falls short goes back for the rounds the step allows, a gone teammate is matched by role
// or picked by the bot, a failed step goes on once fixed, and a step's check is honoured.
import { describe, expect, it } from "vitest";

import { workflowSchema, type Workflow } from "../../shared/skill-burger/format.ts";
import { runText } from "../drivers/agents-workflow-tool.ts";
import { readReview } from "./delegate-step.ts";
import { resumeRun, startRun, type RunDeps, type RunEnvelope, type RunState, type StepExecutors } from "./runner.ts";

const wf = (steps: unknown[], args: Workflow["args"] = {}): Workflow => {
  const checked = workflowSchema.safeParse({ version: 1, summary: "QA-test a site", args, steps });
  if (!checked.success) throw new Error(checked.error.message);
  return checked.data;
};

const qa = (rounds = 1) => wf([
  {
    id: "s1", kind: "delegate", label: "Ask Kiwi, Rio and Miso",
    tasks: [
      { bot: { id: "kiwi", name: "Kiwi", role: "Accessibility tester" }, message: ["QA-test ", { $arg: "site" }, " for accessibility."], doneWhen: "3 findings, each naming the URL" },
      { bot: { id: "rio", name: "Rio", role: "Performance tester" }, message: ["QA-test ", { $arg: "site" }, " for speed."], doneWhen: "3 findings, each naming the URL" },
      { bot: { id: "miso", name: "Miso", role: "Content tester" }, message: ["QA-test ", { $arg: "site" }, " for content."], doneWhen: "3 findings, each naming the URL" },
    ],
    review: { rounds, example: "Rio: re-check your top finding" },
  },
  { id: "s2", kind: "ai", deterministic: false, label: "Review what came back and report", prompt: "Give a short verdict.", input: { $step: "s1", path: "text" } },
], { site: { default: "https://mausbot.com", label: "site" } });

/** A coordinator: hands out request ids, and settles each when the test says so. */
function team(roster: Array<{ id: string; name: string; title?: string }> = [{ id: "kiwi", name: "Kiwi", title: "Accessibility tester" }, { id: "rio", name: "Rio", title: "Performance tester" }, { id: "miso", name: "Miso", title: "Content tester" }]) {
  const sent: Array<{ botIds: string[]; message: string; doneWhen?: string; rework?: boolean }> = [];
  const status = new Map<string, { status: string; result: string; bot: string }>();
  let n = 0;
  const exec: StepExecutors = {
    shell: async () => ({ ok: true, output: "" }), app: async () => ({ ok: true, output: {} }), browser: async () => ({ ok: true, output: "" }), file: async () => ({ ok: true, output: "" }),
    teammates: async () => roster,
    delegate: async (input) => {
      sent.push({ botIds: input.botIds, message: input.message, ...(input.doneWhen ? { doneWhen: input.doneWhen } : {}), ...(input.rework ? { rework: true } : {}) });
      return { ok: true, receipts: input.botIds.map((botId) => { const requestId = `req-${++n}`; status.set(requestId, { status: "running", result: "", bot: botId }); return { botId, name: roster.find((bot) => bot.id === botId)!.name, requestId }; }) };
    },
    assignment: async (id) => status.get(id) ?? null,
  };
  const reply = (bot: string, result: string) => { for (const one of status.values()) if (one.bot === bot && one.status === "running") Object.assign(one, { status: "completed", result }); };
  return { exec, sent, reply };
}

function harness(exec: StepExecutors) {
  const saved: RunState[] = [];
  const events: string[] = [];
  const deps: RunDeps = { exec, save: (state) => saved.push(structuredClone(state)), events: { started: (_r, _n, step) => events.push(`start ${step.id}`), ended: (_r, _n, step, result) => events.push(`${result.state} ${step.id}`) } };
  const last = () => saved[saved.length - 1]!;
  return { deps, saved, events, last, resume: (response: string) => resumeRun(last(), response, deps) };
}

describe("a saved delegation", () => {
  it("sends every part at once with the new input, pauses, then reviews and goes on", async () => {
    const t = team();
    const h = harness(t.exec);
    const first = await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa(), args: { site: "https://example.org" } }, h.deps);
    expect(first).toMatchObject({ status: "needs_input", requiresInput: { type: "teammates", step: "s1" } });
    expect(first.defaults).toBeUndefined();
    expect(t.sent.map((call) => [call.botIds, call.message])).toEqual([
      [["kiwi"], "QA-test https://example.org for accessibility."], [["rio"], "QA-test https://example.org for speed."], [["miso"], "QA-test https://example.org for content."],
    ]);
    expect(t.sent.every((call) => call.doneWhen === "3 findings, each naming the URL")).toBe(true);
    expect(runText(first as never)).toContain("End your turn");

    // Resumed before everyone replied: it waits again and sends nothing new.
    t.reply("kiwi", "1. contrast https://example.org/ 2. … 3. …");
    const early = await h.resume("back");
    expect(early).toMatchObject({ status: "needs_input", requiresInput: { type: "teammates" } });
    expect(early.requiresInput!.prompt).toContain("Still waiting on Rio, Miso");
    expect(t.sent).toHaveLength(3);

    t.reply("rio", "1. LCP 3.4 s on https://example.org/ …");
    t.reply("miso", "Looks fine.");
    const review = await h.resume("back");
    expect(review).toMatchObject({ status: "needs_input", requiresInput: { type: "review" } });
    expect(review.requiresInput!.input).toContain("## Miso");
    expect(review.requiresInput!.prompt).toContain("Kiwi: 3 findings, each naming the URL");

    // Miso's reply falls short: only Miso goes back, as rework, with the fix and the original ask.
    const rework = await h.resume('{"redo": {"Miso": "Give 3 findings, each with the URL you checked."}}');
    expect(rework).toMatchObject({ status: "needs_input", requiresInput: { type: "teammates" } });
    expect(t.sent.slice(3)).toEqual([{ botIds: ["miso"], message: "Give 3 findings, each with the URL you checked.\n\nThe work, as first asked:\nQA-test https://example.org for content.", doneWhen: "3 findings, each naming the URL", rework: true }]);

    t.reply("miso", "1. broken link https://example.org/x 2. … 3. …");
    const ai = await h.resume("back");
    // The one extra round is used: no second review, the step is done and the bot's review step is next.
    expect(ai).toMatchObject({ status: "needs_input", requiresInput: { type: "ai_step", step: "s2" } });
    expect(ai.requiresInput!.input).toContain("broken link https://example.org/x");
    expect(ai.requiresInput!.input).toContain("LCP 3.4 s");
    const done = await h.resume("Verdict: ship it.");
    expect(done).toMatchObject({ ok: true, status: "ok", output: "Verdict: ship it." });
    expect(h.events.filter((event) => event.endsWith("s1"))).toEqual(["start s1", "done s1"]);
  });

  it("says which saved inputs it reused when the request gave none", async () => {
    const t = team();
    const envelope = await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa() }, harness(t.exec).deps);
    expect(envelope.defaults).toEqual([{ name: "site", value: "https://mausbot.com" }]);
    expect(runText(envelope as never)).toContain('the run used the saved value: site = "https://mausbot.com"');
  });

  it("finishes when the review says every reply is done, and stops sending back after the allowed rounds", async () => {
    const t = team();
    const h = harness(t.exec);
    await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa(1) }, h.deps);
    for (const bot of ["kiwi", "rio", "miso"]) t.reply(bot, `${bot} done`);
    await h.resume("back");
    expect(await h.resume('{"redo": {}}')).toMatchObject({ requiresInput: { type: "ai_step", step: "s2" } });
    expect(t.sent).toHaveLength(3);
    expect(readReview("done", { round: 1, who: {}, requests: [], replies: {} })).toEqual({});
    expect(readReview("not json", { round: 1, who: {}, requests: [], replies: {} })).toBeNull();
  });

  it("gives a gone teammate's part to the one with its role, or asks the bot who does it", async () => {
    // Kiwi is gone; Ada has Kiwi's role. Rio is gone and nobody has its role.
    const t = team([{ id: "ada", name: "Ada", title: "Accessibility tester" }, { id: "miso", name: "Miso", title: "Content tester" }, { id: "zed", name: "Zed", title: "SRE" }]);
    const h = harness(t.exec);
    const asked = await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa() }, h.deps);
    expect(asked).toMatchObject({ status: "needs_input", requiresInput: { type: "missing_bot" } });
    expect(asked.requiresInput!.prompt).toContain("Rio (Performance tester) isn't one of your teammates any more");
    expect(t.sent).toHaveLength(0);
    expect(await h.resume("Bob")).toMatchObject({ status: "needs_input", requiresInput: { type: "missing_bot", prompt: expect.stringContaining("Bob isn't one of your teammates") } });
    const sent = await h.resume("Zed");
    expect(sent).toMatchObject({ requiresInput: { type: "teammates" } });
    expect(t.sent.map((call) => [call.botIds, call.message])).toEqual([
      [["ada"], "QA-test https://mausbot.com for accessibility."], [["zed"], "QA-test https://mausbot.com for speed."], [["miso"], "QA-test https://mausbot.com for content."],
    ]);
  });

  it("can leave a gone teammate's part out", async () => {
    const t = team([{ id: "kiwi", name: "Kiwi" }, { id: "miso", name: "Miso" }]);
    const h = harness(t.exec);
    await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa() }, h.deps);
    await h.resume("skip");
    expect(t.sent.map((call) => call.botIds[0])).toEqual(["kiwi", "miso"]);
  });

  it("fails the step, names why, and can go on from it once fixed", async () => {
    const t = team();
    let refuse = true;
    const exec: StepExecutors = { ...t.exec, delegate: async (input) => (refuse ? { ok: false, error: "Rio is at its plan's hand-off limit" } : t.exec.delegate!(input)) };
    const h = harness(exec);
    const failed: RunEnvelope = await startRun({ name: "qa", botId: "lead", threadId: "t1", sha256: "x", workflow: qa() }, h.deps);
    expect(failed).toMatchObject({ ok: false, error: { step: "s1", message: '"Ask Kiwi, Rio and Miso" failed: Rio is at its plan\'s hand-off limit', resumeToken: failed.run } });
    expect(runText(failed as never)).toContain(`call run_workflow with resume "${failed.run}" to go on from that step`);
    refuse = false;
    expect(await h.resume("fixed")).toMatchObject({ requiresInput: { type: "teammates" } });
  });
});

describe("a step's check", () => {
  const shell = (check: unknown) => wf([
    { id: "s1", kind: "shell", label: "Count rows", run: "wc -l < done.csv", check },
    { id: "s2", kind: "shell", label: "Archive", run: "cp done.csv archive/" },
  ]);
  const runWith = (output: string, check: unknown) => {
    const h = harness({ shell: async () => ({ ok: true, output }), app: async () => ({ ok: true, output: {} }), browser: async () => ({ ok: true, output: "" }), file: async () => ({ ok: true, output: "" }) });
    return { h, run: startRun({ name: "csv", botId: "b", threadId: "t", sha256: "x", workflow: shell(check) }, h.deps) };
  };

  it("fails a step whose rule doesn't hold, and passes one whose rule does", async () => {
    expect(await runWith("0", { says: "there is at least one row", rule: { op: "gt", value: 0 } }).run).toMatchObject({ ok: false, error: { step: "s1", message: expect.stringContaining("its check didn't hold: there is at least one row") } });
    expect(await runWith("12", { says: "there is at least one row", rule: { op: "gt", value: 0 } }).run).toMatchObject({ ok: true, status: "ok" });
  });

  it("asks the bot when only words say what done means", async () => {
    const { h, run } = runWith("12", { says: "the CSV has a header row" });
    expect(await run).toMatchObject({ status: "needs_input", requiresInput: { type: "check", step: "s1", input: "12" } });
    expect(await h.resume("fail: no header")).toMatchObject({ ok: false, error: { message: '"Count rows" didn\'t pass its check: no header' } });
    expect(await h.resume("go on")).toMatchObject({ status: "needs_input", requiresInput: { type: "check" } });
    expect(await h.resume("pass")).toMatchObject({ ok: true, status: "ok" });
  });
});

describe("the run_workflow tool", () => {
  it("reads resume and response nested inside args as a resume, never as a new run", async () => {
    const { callWorkflowTool } = await import("../drivers/agents-workflow-tool.ts");
    const calls: Array<{ path: string; body: unknown }> = [];
    const context = { client: { apiResponse: async (path: string, init: { body: string }) => { calls.push({ path, body: JSON.parse(init.body) }); return { ok: true, status: 200, body: { protocolVersion: 1, ok: true, status: "ok", run: "r", steps: [] } }; } } };
    await callWorkflowTool("run_workflow", { name: "qa", args: { resume: "run-7", response: "Wrote wait.md" } }, context as never);
    await callWorkflowTool("run_workflow", { name: "qa", resume: "run-7", response: { redo: { Rio: "add the URL" } } }, context as never);
    expect(calls).toEqual([
      { path: "/api/internal/skill-burgers/resume", body: { run: "run-7", response: "Wrote wait.md" } },
      { path: "/api/internal/skill-burgers/resume", body: { run: "run-7", response: '{"redo":{"Rio":"add the URL"}}' } },
    ]);
  });
});
