import { describe, expect, it } from "vitest";
import type { ScenarioResult } from "../../scorers/snapshot.ts";
import { behaviorTrace } from "./behavior-trace.ts";
import { diffTrace } from "./diff-trace.ts";

function result(overrides: Partial<ScenarioResult>): ScenarioResult {
  return {
    id: "unit",
    title: "title",
    behavior: "behavior",
    world: "coordination",
    pass: true,
    startedAt: "2026-09-25T00:00:00.000Z",
    durationMs: 1,
    steps: [],
    assertions: [],
    assertionsInput: [],
    evidence: { turns: [], handoffs: [], sends: [] },
    ...overrides,
  };
}

describe("behaviorTrace", () => {
  it("normalizes turns to sorted argument keys and stable handoffs/sends", () => {
    const trace = behaviorTrace(
      result({
        pass: false,
        evidence: {
          turns: [
            {
              bot: "chief",
              index: 0,
              threadId: "t1",
              system: "system",
              prompt: "prompt",
              toolCalls: [
                { tool: "coordinate_bots", arguments: { request_key: "x", bot_ids: ["b"] }, errored: false },
                { tool: "list_bots", arguments: {}, errored: true },
              ],
            },
          ],
          handoffs: [
            { bot: "chief", status: "completed", threadId: "h1" },
            { bot: "lead", status: "completed", threadId: "h2", hasParent: true },
          ],
          sends: [{ bot: "chief", text: "hello", queued: undefined }],
        },
      }),
    );
    expect(trace).toEqual({
      id: "unit",
      turns: [
        {
          bot: "chief",
          index: 0,
          calls: [
            { tool: "coordinate_bots", argKeys: ["bot_ids", "request_key"], errored: false },
            { tool: "list_bots", argKeys: [], errored: true },
          ],
        },
      ],
      handoffs: [
        { bot: "chief", status: "completed" },
        { bot: "lead", status: "completed", hasParent: true },
      ],
      sends: [{ bot: "chief", queued: undefined }],
      outcome: "fail",
    });
  });
});

describe("diffTrace", () => {
  it("is silent for identical traces and reports drift readably", () => {
    const baseline = behaviorTrace(result({}));
    expect(diffTrace(baseline, behaviorTrace(result({})))).toEqual([]);

    const drifted = behaviorTrace(
      result({
        evidence: {
          turns: [
            {
              bot: "chief",
              index: 0,
              threadId: "t1",
              system: "",
              prompt: "",
              toolCalls: [{ tool: "send_message", arguments: {}, errored: false }],
            },
          ],
          handoffs: [],
          sends: [],
        },
      }),
    );
    const deltas = diffTrace(baseline, drifted);
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.join("\n")).toContain("send_message");
  });
});
