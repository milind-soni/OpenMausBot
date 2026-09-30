import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { TASK_OUTCOME } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import { TASK_OUTCOME_MIN_PROBABILITY, decideTaskOutcome, taskOutcomeRequest, type TaskOutcomeInput } from "./task-outcome.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

const INPUT: TaskOutcomeInput = {
  name: "Morning invoices",
  prompt: "Sign in to the billing portal and download yesterday's invoices.",
  reply: "I couldn't sign in to the billing portal: the password was rejected. You may need to reset it.",
};

type Choose = Decider["choose"];

function answering(result: DeciderResult<ChoiceAnswer>) {
  const choose = vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn>;
  return { choose };
}

const picked = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 410, answers: { type: "choice", choice, pTop, margin: pTop - 0.1, probabilities: { [choice]: pTop } } });

const asked = (request: ReturnType<typeof taskOutcomeRequest>) => ({ answer: { type: "choice" as const, ...request.question } });

describe("task outcome request", () => {
  it("sends the contract's question verbatim with only its state keys", () => {
    const request = taskOutcomeRequest(INPUT);
    expect(request.question).toEqual({ instructions: TASK_OUTCOME.instructions, options: TASK_OUTCOME.options });
    expect(request.state).toEqual({
      task: "Morning invoices: Sign in to the billing portal and download yesterday's invoices.",
      final_reply: INPUT.reply,
    });
    expect(relayAccepts("taskOutcome", request.state, asked(request))).toBe(true);
  });

  it("keeps the end of a long reply, where the conclusion is", () => {
    const reply = `${"Checked the inbox and sorted twelve threads. ".repeat(400)}In the end I could not open the portal.`;
    const { state } = taskOutcomeRequest({ ...INPUT, reply });
    expect(state.final_reply.length).toBeLessThanOrEqual(6_000);
    expect(state.final_reply.startsWith("…")).toBe(true);
    expect(state.final_reply.endsWith("In the end I could not open the portal.")).toBe(true);
  });

  it("clips the task and never sends a secret from the reply", () => {
    const { state } = taskOutcomeRequest({ ...INPUT, prompt: "p".repeat(5_000), reply: "Done. Token was sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH" });
    expect(state.task.length).toBeLessThanOrEqual(1_500);
    expect(state.final_reply).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("stays inside the relay's caps for a huge reply in wide characters", () => {
    const request = taskOutcomeRequest({ name: "日報".repeat(200), prompt: "請".repeat(9_000), reply: "失敗しました。😀".repeat(20_000) });
    expect(Buffer.byteLength(JSON.stringify(request.state))).toBeLessThanOrEqual(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("taskOutcome", request.state, asked(request))).toBe(true);
  });
});

describe("decideTaskOutcome", () => {
  it("a clear blocked answer is blocked, with the contract's budget", async () => {
    const decider = answering(picked("blocked", 0.91));
    await expect(decideTaskOutcome(decider, INPUT)).resolves.toEqual({ kind: "blocked", probability: 0.91 });
    expect(decider.choose).toHaveBeenCalledWith("taskOutcome", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: TASK_OUTCOME.timeoutMs }));
  });

  it("exactly the threshold acts; below it keeps today's done", async () => {
    await expect(decideTaskOutcome(answering(picked("blocked", TASK_OUTCOME_MIN_PROBABILITY)), INPUT)).resolves.toMatchObject({ kind: "blocked" });
    await expect(decideTaskOutcome(answering(picked("blocked", 0.74)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "low_confidence" });
  });

  it("done and nothing keep today's done, however sure", async () => {
    await expect(decideTaskOutcome(answering(picked("done", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "not_blocked" });
    await expect(decideTaskOutcome(answering(picked("nothing", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "not_blocked" });
  });

  it("any decider failure, an unknown choice or a throw falls back", async () => {
    for (const reason of ["timeout", "overloaded", "disabled", "job_off"] as const) {
      await expect(decideTaskOutcome(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ kind: "fallback", reason });
    }
    await expect(decideTaskOutcome(answering(picked("maybe", 0.99)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
    const choose = vi.fn(async () => { throw new Error("boom"); }) as unknown as Choose;
    await expect(decideTaskOutcome({ choose }, INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("does not ask when there is no reply to read", async () => {
    const decider = answering(picked("blocked", 0.99));
    await expect(decideTaskOutcome(decider, { ...INPUT, reply: "  " })).resolves.toEqual({ kind: "fallback", reason: "no_reply" });
    expect(decider.choose).not.toHaveBeenCalled();
  });
});
