import { describe, expect, it, vi } from "vitest";

import type { Decider } from "./index.ts";
import { WORK_PLACE } from "./jobs.ts";
import { relayAccepts } from "./relay.ts";
import { WORK_PLACE_MIN_PROBABILITY, decideWorkPlace, workPlaceRequest, type WorkPlaceInput } from "./work-place.ts";
import type { ChoiceAnswer, DeciderResult } from "./types.ts";

const INPUT: WorkPlaceInput = {
  message: "Open Keynote on my Mac and export the launch deck as a PDF.",
  bot: { name: "Maya", description: "Product designer. Owns the launch deck." },
  places: ["cloud_computer", "local_vm", "this_computer"],
};

type Choose = Decider["choose"];

function answering(result: DeciderResult<ChoiceAnswer>) {
  const choose = vi.fn(async () => result) as unknown as Choose & ReturnType<typeof vi.fn>;
  return { choose };
}

const picked = (choice: string, pTop: number): DeciderResult<ChoiceAnswer> =>
  ({ ok: true, provider: "jev", latencyMs: 280, answers: { type: "choice", choice, pTop, margin: pTop - 0.1, probabilities: { [choice]: pTop } } });

describe("work place request", () => {
  it("offers only the places given, with plain meanings, and the contract's instructions", () => {
    const { state, question } = workPlaceRequest({ ...INPUT, places: ["this_computer", "cloud_computer"] });
    expect(Object.keys(question.options)).toEqual(["this_computer", "cloud_computer"]);
    expect(question.options.this_computer).toMatch(/^This computer: the person's own Mac or PC/);
    expect(question.instructions).toBe(WORK_PLACE.instructions);
    expect(state).toEqual({ message: INPUT.message, bot: "Maya: Product designer. Owns the launch deck." });
    expect(relayAccepts("workPlace", state, { answer: { type: "choice", ...question } })).toBe(true);
  });

  it("clips the message and the bot, and a long realistic request still fits Cloud Pro's relay", () => {
    const { state, question } = workPlaceRequest({
      message: "Bitte öffne die Tabelle – 请打开表格 ".repeat(400),
      bot: { name: "Research assistant", description: "Finds sources, reads papers — 論文を読む. ".repeat(40) },
      places: INPUT.places,
    });
    expect(state.message.length).toBe(1_500);
    expect(state.bot!.length).toBe(400);
    expect(relayAccepts("workPlace", state, { answer: { type: "choice", ...question } })).toBe(true);
  });
});

describe("decideWorkPlace", () => {
  it("a confident place is tried first", async () => {
    const decider = answering(picked("this_computer", 0.91));
    await expect(decideWorkPlace(decider, INPUT)).resolves.toEqual({ kind: "place", place: "this_computer", probability: 0.91 });
    expect(decider.choose).toHaveBeenCalledWith("workPlace", expect.any(Object), expect.any(Object), expect.objectContaining({ timeoutMs: WORK_PLACE.timeoutMs }));
  });

  it("exactly 0.7 is confident enough; below keeps today's order", async () => {
    await expect(decideWorkPlace(answering(picked("local_vm", WORK_PLACE_MIN_PROBABILITY)), INPUT)).resolves.toMatchObject({ kind: "place", place: "local_vm" });
    await expect(decideWorkPlace(answering(picked("local_vm", 0.69)), INPUT)).resolves.toEqual({ kind: "fallback", reason: "low_confidence" });
  });

  it("does not ask with fewer than two places, or no message", async () => {
    const decider = answering(picked("cloud_computer", 0.99));
    await expect(decideWorkPlace(decider, { ...INPUT, places: ["cloud_computer"] })).resolves.toEqual({ kind: "fallback", reason: "no_choice" });
    await expect(decideWorkPlace(decider, { ...INPUT, places: ["cloud_computer", "cloud_computer"] })).resolves.toEqual({ kind: "fallback", reason: "no_choice" });
    await expect(decideWorkPlace(decider, { ...INPUT, message: "  " })).resolves.toEqual({ kind: "fallback", reason: "no_choice" });
    expect(decider.choose).not.toHaveBeenCalled();
  });

  it("a place that was not offered falls back", async () => {
    await expect(decideWorkPlace(answering(picked("local_vm", 0.95)), { ...INPUT, places: ["this_computer", "cloud_computer"] }))
      .resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });

  it("any failure, or a decider that throws, keeps today's order", async () => {
    for (const reason of ["timeout", "rate_limited", "disabled", "misconfigured"] as const) {
      await expect(decideWorkPlace(answering({ ok: false, reason }), INPUT)).resolves.toEqual({ kind: "fallback", reason });
    }
    const choose = vi.fn(async () => { throw new Error("boom"); }) as unknown as Choose;
    await expect(decideWorkPlace({ choose }, INPUT)).resolves.toEqual({ kind: "fallback", reason: "malformed" });
  });
});
