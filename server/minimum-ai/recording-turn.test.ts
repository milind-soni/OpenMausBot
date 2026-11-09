import { expect, it } from "vitest";
import { createRecordingTurns } from "./recording-turn.ts";

it("returns a recording only when the same turn's browser calls all complete successfully", () => {
  const turns = createRecordingTurns();
  const run = turns.begin("thread", "bot");
  const recorder = turns.browserCall("thread", "bot", "generation");
  expect(recorder).toBeDefined();
  turns.started("thread", "call-1", "mcp__browser__agent_browser_open");
  recorder!.record({ kind: "open", url: "https://example.test/" });
  turns.completed("thread", "call-1", true);
  expect(run.finish(true)).toEqual([{ kind: "open", url: "https://example.test/" }]);
  expect(turns.browserCall("thread", "bot", "generation")).toBeUndefined();
});

it("refuses missing, failed, foreign or unobserved actions and changed generations", () => {
  for (const variant of ["foreign", "missing", "failed", "count", "generation", "failed-turn"] as const) {
    const turns = createRecordingTurns(), run = turns.begin("thread", "bot");
    const recorder = turns.browserCall("thread", "bot", "g1")!;
    recorder.record({ kind: "open", url: "https://example.test/" });
    turns.started("thread", "call", variant === "foreign" ? "mcp__computer__click" : "mcp__browser__agent_browser_open");
    if (variant !== "missing") turns.completed("thread", "call", variant !== "failed");
    if (variant === "count") turns.browserCall("thread", "bot", "g1");
    if (variant === "generation") turns.browserCall("thread", "bot", "g2");
    expect(() => run.finish(variant !== "failed-turn"), variant).toThrow();
  }
});

it("isolates threads, rejects overlapping recordings and closes on cancellation", () => {
  const turns = createRecordingTurns(), run = turns.begin("a", "bot");
  expect(() => turns.begin("a", "bot")).toThrow();
  expect(turns.browserCall("a", "other-bot", "g")).toBeUndefined();
  expect(turns.browserCall("b", "bot", "g")).toBeUndefined();
  run.cancel();
  expect(() => run.finish(true)).toThrow();
  expect(() => turns.begin("a", "bot")).not.toThrow();
});
