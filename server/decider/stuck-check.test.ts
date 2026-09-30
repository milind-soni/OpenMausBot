import { describe, expect, it, vi } from "vitest";

import type { Message } from "../store.ts";
import type { Decider } from "./index.ts";
import { STUCK_CHECK } from "./jobs.ts";
import { RELAY_MAX_STATE_BYTES, relayAccepts } from "./relay.ts";
import {
  STUCK_MIN_PROBABILITY, STUCK_RECENT_STEPS, decideStuck, lastUserText, recentToolSteps, stuckCheckRequest, stuckChip,
} from "./stuck-check.ts";
import type { DeciderResult, YesNoAnswer } from "./types.ts";

type YesNo = Decider["yesNo"];

function answering(result: DeciderResult<YesNoAnswer>) {
  const yesNo = vi.fn(async () => result) as unknown as YesNo & ReturnType<typeof vi.fn>;
  return { yesNo };
}

const yes = (p: number): DeciderResult<YesNoAnswer> => ({ ok: true, provider: "jev", latencyMs: 400, answers: { type: "yesno", p } });

let id = 0;
const user = (text: string): Message => ({ id: `m${id++}`, role: "user", kind: "text", text }) as Message;
const step = (name: string, summary?: string, input?: string): Message =>
  ({ id: `m${id++}`, role: "bot", kind: "activity", tool: { name, summary, input, itemId: `item-${id}` } }) as Message;
const chip = (name: string): Message => ({ id: `m${id++}`, role: "bot", kind: "activity", tool: { name, ok: false } }) as Message;

const INPUT = {
  task: "Get the test suite green",
  steps: Array.from({ length: 6 }, () => "Bash: npm test -- auth.test.ts"),
};

describe("recent tool steps", () => {
  it("keeps the latest provider tool calls, oldest first, one line each, without the harness's chips", () => {
    const path = [
      user("Fix the login bug"),
      step("Read", undefined, "src/login.ts"),
      chip("Same call repeated 5× — tool: npm test — it may be stuck"),
      step("Bash", "npm test", '{"command":"npm test"}'),
      step("Edit"),
    ];
    expect(recentToolSteps(path)).toEqual(["Read: src/login.ts", 'Bash: npm test {"command":"npm test"}', "Edit"]);
  });

  it(`keeps at most ${STUCK_RECENT_STEPS}, each clipped`, () => {
    const path = Array.from({ length: 40 }, (_, i) => step("Bash", `run ${i} ${"x".repeat(900)}`));
    const steps = recentToolSteps(path);
    expect(steps).toHaveLength(STUCK_RECENT_STEPS);
    expect(steps.at(-1)!.startsWith("Bash: run 39")).toBe(true);
    expect(steps.every((line) => line.length <= 300)).toBe(true);
  });

  it("reads what the person last asked", () => {
    expect(lastUserText([user("first"), step("Bash", "ls"), user("second"), step("Bash", "ls")])).toBe("second");
    expect(lastUserText([step("Bash", "ls")])).toBeUndefined();
  });
});

describe("stuck check request", () => {
  it("asks the contract's exact question with only its state keys", () => {
    const { state, instructions } = stuckCheckRequest(INPUT);
    expect(instructions).toBe(STUCK_CHECK.instructions);
    expect(state).toEqual({ task: INPUT.task, recent_steps: INPUT.steps });
    expect(relayAccepts("stuckCheck", state, { answer: { type: "yesno", instructions } })).toBe(true);
    expect(stuckCheckRequest({ steps: ["Bash: ls"] }).state).toEqual({ recent_steps: ["Bash: ls"] });
  });

  it("a long task and many long steps still fit the relay's caps", () => {
    const { state, instructions } = stuckCheckRequest({
      task: "é".repeat(20_000),
      steps: Array.from({ length: 200 }, (_, i) => `Bash: ${i} ${"ü".repeat(5_000)}`),
    });
    expect(state.recent_steps).toHaveLength(STUCK_RECENT_STEPS);
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(RELAY_MAX_STATE_BYTES);
    expect(relayAccepts("stuckCheck", state, { answer: { type: "yesno", instructions } })).toBe(true);
  });
});

describe("decideStuck", () => {
  it(`reports stuck at ${STUCK_MIN_PROBABILITY} or above`, async () => {
    const decider = answering(yes(0.91));
    await expect(decideStuck(decider, INPUT)).resolves.toEqual({ stuck: true, probability: 0.91 });
    expect(decider.yesNo).toHaveBeenCalledWith("stuckCheck", expect.any(Object), STUCK_CHECK.instructions, { timeoutMs: STUCK_CHECK.timeoutMs });
    await expect(decideStuck(answering(yes(0.8)), INPUT)).resolves.toMatchObject({ stuck: true });
  });

  it("says nothing when less sure", async () => {
    await expect(decideStuck(answering(yes(0.79)), INPUT)).resolves.toEqual({ stuck: false, reason: "not_stuck" });
  });

  it("any failure or odd answer says nothing", async () => {
    for (const reason of ["timeout", "overloaded", "malformed", "disabled"] as const) {
      await expect(decideStuck(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ stuck: false, reason });
    }
    await expect(decideStuck(answering(yes(Number.NaN)), INPUT)).resolves.toEqual({ stuck: false, reason: "malformed" });
    const yesNo = vi.fn(async () => { throw new Error("boom"); }) as unknown as YesNo;
    await expect(decideStuck({ yesNo }, INPUT)).resolves.toEqual({ stuck: false, reason: "malformed" });
  });

  it("does not ask with no steps to judge", async () => {
    const decider = answering(yes(0.99));
    await expect(decideStuck(decider, { task: "x", steps: [] })).resolves.toEqual({ stuck: false, reason: "no_steps" });
    expect(decider.yesNo).not.toHaveBeenCalled();
  });

  it("names the bot in its chip", () => {
    expect(stuckChip("Scout")).toBe("Scout looks stuck: repeating the same steps. Stop it or give it a hint.");
  });
});
