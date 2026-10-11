// What a requester (a Chief, a lead) learns when the turn it assigned ends
// without completing: the runtime's cause, what the turn did first, the step
// cap's handoff, and the turn's last message whole — never a bare "error".
import { describe, expect, it } from "vitest";

import type { RuntimeEvent } from "./contracts.ts";
import type { Message } from "./store.ts";
import { TurnStops, stoppedTurnOutcome } from "./turn-outcome.ts";

const event = (fields: Record<string, unknown>): RuntimeEvent =>
  ({ eventId: "e", provider: "fake", threadId: "t1", createdAt: "", ...fields }) as unknown as RuntimeEvent;
const STEP_CAP = "Stopped after 64 steps without a final answer. The steps so far already ran, so ask only for what's left.";

const tool = (name: string, ok: boolean, turnId = "turn-1"): Message =>
  ({ id: `m-${Math.random()}`, role: "bot", kind: "activity", at: 1, turnId, tool: { name, ok, itemId: `i-${Math.random()}` } }) as Message;

describe("TurnStops", () => {
  it("keeps the runtime's error and the step cap's handoff for the turn that failed", () => {
    const stops = new TurnStops();
    stops.note(event({ type: "turn.started", turnId: "turn-1" }));
    stops.note(event({ type: "runtime.error", turnId: "turn-1", message: STEP_CAP }));
    stops.note(event({ type: "cap.exhausted", turnId: "turn-1", handoffPath: "/data/handoffs/cap-1.md", reason: "cap" }));
    expect(stops.read("t1", "turn-1")).toEqual({ turnId: "turn-1", error: STEP_CAP, handoffPath: "/data/handoffs/cap-1.md" });
    // another turn's settle never reads it, nor does another thread
    expect(stops.read("t1", "turn-2")).toBeUndefined();
    expect(stops.read("t2", "turn-1")).toBeUndefined();
  });

  // Claude reports a usage limit or an overload as a reply its client wrote,
  // not the model: that text is the cause, a model's own words are not.
  it("takes a provider's error sent as a reply for the cause", () => {
    const stops = new TurnStops();
    stops.note(event({ type: "item.completed", itemType: "assistant_text", turnId: "turn-1", text: "Half the export is done." }));
    expect(stops.read("t1", "turn-1")).toBeUndefined();
    const limit = "You've hit your weekly limit · resets 6pm (Europe/Berlin)";
    stops.note(event({ type: "item.completed", itemType: "assistant_text", turnId: "turn-1", text: limit, synthetic: true }));
    expect(stops.read("t1", "turn-1")).toEqual({ turnId: "turn-1", error: limit });
  });

  it("starts each turn clean and never records a client abort as a cause", () => {
    const stops = new TurnStops();
    stops.note(event({ type: "runtime.error", turnId: "turn-1", message: "upstream HTTP 429: Rate limit reached" }));
    stops.note(event({ type: "turn.started", turnId: "turn-2" }));
    expect(stops.read("t1")).toBeUndefined();
    stops.note(event({ type: "runtime.error", turnId: "turn-2", message: "The request was cancelled by the client." }));
    expect(stops.read("t1", "turn-2")).toBeUndefined();
  });
});

describe("stoppedTurnOutcome", () => {
  it("leads with the cause, then what the turn did and where its handoff is", () => {
    const text = stoppedTurnOutcome({
      reason: STEP_CAP, turnId: "turn-1", handoffPath: "/data/handoffs/cap-1.md",
      activities: [tool("Bash", true), tool("Bash", false), tool("Read", true), tool("Edit", true, "turn-0")],
    });
    expect(text.startsWith(STEP_CAP)).toBe(true);
    expect(text).toContain("Before it stopped it made 3 tool calls: Bash ×2 (1 failed), Read ×1.");
    expect(text).toContain("Every step it took is listed in /data/handoffs/cap-1.md; to finish, assign what is left and point to that file.");
    expect(text).not.toContain("Edit");
  });

  it("returns the turn's last message whole after the cause", () => {
    const report = `Implemented the export.\n\n${"Checked boundary case. ".repeat(80)}\nAll 12 tests pass.`;
    const text = stoppedTurnOutcome({ reason: "One or more tool operations failed or were denied", turnId: "turn-1", activities: [], said: report });
    expect(text).toBe(`One or more tool operations failed or were denied. No tool calls were seen before it stopped.\nIts last message:\n${report}`);
  });

  it("says why a harness stop happened in one sentence, and cuts a provider's long body", () => {
    expect(stoppedTurnOutcome({ reason: "no activity for 20 minutes — the turn was stopped", activities: [] }))
      .toBe("No activity for 20 minutes — the turn was stopped.");
    const body = stoppedTurnOutcome({ reason: `upstream HTTP 502: ${"<html>".repeat(500)}`, activities: [] });
    expect(body.length).toBeLessThanOrEqual(601);
    expect(body.startsWith("Upstream HTTP 502:")).toBe(true);
  });
});
