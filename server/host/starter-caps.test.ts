import { describe, expect, it } from "vitest";

import type { StarterAwake } from "./starter-awake.ts";
import { createStarterCaps, STARTER_RUNNING_TURNS, STARTER_WAITING_HANDOFFS } from "./starter-caps.ts";
import { PAUSED_RUN_ROUTINE_TURNS_ONLY } from "./starter-routine-wake.ts";

const awake = (paused: string[]): StarterAwake => ({
  limit: () => 5, paused: () => paused, isPaused: (id) => paused.includes(id), choose: () => ({ ok: true }), wakeForRoutine: () => ({ kind: "awake" }), useRoutines: () => {},
});

function caps(options: { starter?: boolean; paused?: string[]; routineThreads?: Record<string, string> } = {}) {
  let refused = 0, clock = 1_000;
  const made = createStarterCaps({
    starter: () => options.starter ?? true, awake: awake(options.paused ?? []), waitsOnOthers: () => false, botName: (id) => id,
    routineThread: (botId, threadId) => options.routineThreads?.[threadId] === botId,
    pausedLine: (language, limit) => `${language ?? "en"}: paused, ${limit} awake`, now: () => clock, refused: () => { refused++; },
  });
  return { made, refusals: () => refused, advance: (ms: number) => { clock += ms; } };
}

describe("how much work a Starter Cloud runs at once", () => {
  it("runs two turns at once on Starter and leaves other plans alone", () => {
    expect(STARTER_RUNNING_TURNS).toBe(2);
    expect(caps().made.engine.most()).toBe(2);
    expect(caps({ starter: false }).made.engine.most()).toBeUndefined();
  });

  it("refuses a hand-off once two run and four wait, telling the model and the app", () => {
    const { made, refusals } = caps();
    const full = STARTER_RUNNING_TURNS + STARTER_WAITING_HANDOFFS;
    expect(made.handoffs.refusal("helper", () => full - 1)).toBeNull();
    expect(made.status()).toEqual({ running: 2, waiting: 4 });
    expect(made.handoffs.refusal("helper", () => full)).toMatch(/runs 2 tasks at once and holds 4 more waiting/);
    expect([refusals(), made.status()]).toEqual([1, { running: 2, waiting: 4, refusedAt: 1_000, refused: "tasks" }]);
  });

  it("refuses work for a paused bot whatever the queue holds, and its own turn in the person's language", () => {
    const { made } = caps({ paused: ["sleepy"] });
    let counted = false;
    expect(made.handoffs.refusal("sleepy", () => { counted = true; return 0; })).toMatch(/^@sleepy is paused/);
    expect([counted, made.status()?.refused]).toEqual([false, "paused"]);
    expect(made.pausedText("sleepy", "de")).toBe("de: paused, 5 awake");
    expect(made.pausedText("awake", "de")).toBeNull();
  });

  it("lets a limit-paused bot's turn through only in the conversation of its own routine run under way", () => {
    const { made } = caps({ paused: ["sleepy"], routineThreads: { "run-thread": "sleepy", "other-run": "someone" } });
    expect(made.pausedText("sleepy", "de", "run-thread", true)).toBeNull();
    // A turn there that is not the routine's own (a person's new message) passes only without option A.
    expect(made.pausedText("sleepy", "de", "run-thread")).toBe(PAUSED_RUN_ROUTINE_TURNS_ONLY ? "de: paused, 5 awake" : null);
    expect(made.pausedText("sleepy", "de", "main-thread", true)).toBe("de: paused, 5 awake");
    expect(made.pausedText("sleepy", "de", "main-thread")).toBe("de: paused, 5 awake");
    expect(made.pausedText("sleepy", "de", "other-run")).toBe("de: paused, 5 awake");
    expect(made.pausedText("sleepy", "de")).toBe("de: paused, 5 awake");
    // Hand-offs to it are still refused: a routine is no way round the limit for other work.
    expect(made.handoffs.refusal("sleepy", () => 0)).toMatch(/^@sleepy is paused/);
  });

  it("tells a bot that made a paused one, without refusing anything or opening the popup", () => {
    const { made, refusals } = caps({ paused: ["scout"] });
    expect(made.createdPaused("scout")).toMatch(/^@scout was created, and is paused: this Cloud's Starter plan keeps 5 bots awake/);
    expect(made.createdPaused("scout")).not.toMatch(/upgrade this Cloud to create|no room/);
    expect(made.createdPaused("awake")).toBeNull();
    expect(caps({ starter: false, paused: ["scout"] }).made.createdPaused("scout")).toBeNull();
    expect([refusals(), made.status()?.refused]).toEqual([0, undefined]);
  });

  it("refuses nothing off Starter", () => {
    const { made, refusals } = caps({ starter: false, paused: ["sleepy"] });
    expect(made.handoffs.refusal("sleepy", () => 100)).toBeNull();
    expect([made.pausedText("sleepy", undefined), made.status(), refusals()]).toEqual([null, undefined, 0]);
  });
});
