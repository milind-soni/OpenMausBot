import { describe, expect, it } from "vitest";
import { boundedInteractiveState, interactiveStateKey } from "./interactive-state";
describe("interactive state persistence", () => {
  it("isolates tasks, messages, blocks and edits", () => {
    const keys = [
      interactiveStateKey("a", "m", 0, "root"),
      interactiveStateKey("b", "m", 0, "root"),
      interactiveStateKey("a", "n", 0, "root"),
      interactiveStateKey("a", "m", 4, "root"),
      interactiveStateKey("a", "m", 0, "edit"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
  it("round-trips primitive bindings and OpenUI form values", () => {
    const state = { $choice: "Review", $threshold: 8, "flow:Steps": { value: 1 } };
    expect(boundedInteractiveState(state)).toEqual(state);
  });
  it("rejects invalid envelopes, excessive data and prototype keys", () => {
    for (const value of [
      null,
      [],
      "text",
      { $text: "x".repeat(17000) },
      JSON.parse('{"__proto__":{"polluted":true}}'),
    ])
      expect(boundedInteractiveState(value)).toBeUndefined();
  });
});
