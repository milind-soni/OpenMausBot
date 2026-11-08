import { describe, expect, it } from "vitest";

import type { StarterAwake } from "./starter-awake.ts";
import { createStarterCaps, STARTER_RUNNING_TURNS, STARTER_WAITING_HANDOFFS } from "./starter-caps.ts";

const awake = (paused: string[]): StarterAwake => ({ limit: () => 5, paused: () => paused, isPaused: (id) => paused.includes(id), choose: () => ({ ok: true }) });

function caps(options: { starter?: boolean; paused?: string[] } = {}) {
  let refused = 0, clock = 1_000;
  const made = createStarterCaps({
    starter: () => options.starter ?? true, awake: awake(options.paused ?? []), waitsOnOthers: () => false, botName: (id) => id,
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

  it("refuses nothing off Starter", () => {
    const { made, refusals } = caps({ starter: false, paused: ["sleepy"] });
    expect(made.handoffs.refusal("sleepy", () => 100)).toBeNull();
    expect([made.pausedText("sleepy", undefined), made.status(), refusals()]).toEqual([null, undefined, 0]);
  });
});
