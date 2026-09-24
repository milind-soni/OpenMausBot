import { describe, expect, it } from "vitest";
import { evaluateAssertions } from "./assertions.ts";
import type { Assertion } from "../types.ts";
import type { WorldSnapshot } from "./snapshot.ts";

const world: WorldSnapshot = {
  turns: [
    {
      bot: "chief",
      index: 0,
      threadId: "t-chief",
      system: "Assignments you already sent are still outstanding: build",
      prompt: "{\"message\":{\"content\":\"go\"}}",
      toolCalls: [{ tool: "coordinate_bots", arguments: { bot_ids: ["b-lead"], request_key: "build" }, errored: false }],
    },
    { bot: "chief", index: 1, threadId: "t-chief", system: "plain", prompt: "{}", toolCalls: [] },
    { bot: "lead", index: 0, threadId: "t-node", system: "plain", prompt: "{}", toolCalls: [] },
  ],
  handoffs: [{ bot: "lead", status: "completed", threadId: "t-node", hasParent: true }],
  activeThreads: { chief: "t-chief" },
  threads: { "t-chief": [{ text: "The export is done" }], "t-node": [{ text: "done" }] },
  sends: [{ bot: "chief", text: "go", queued: undefined }, { bot: "chief", text: "more", queued: true }],
  observations: {
    firstPoll: { httpStatus: 200, held: true, blockedReason: "Another thread is using this computer" },
    heldRun: { status: "queued", deferredAt: 123, executionThreadId: "t-run" },
    revokedPoll: { httpStatus: 401 },
  },
  activities: (bot) => (bot === "auto"
    ? ["Waiting for its turn on this computer — holder", "error: computer unavailable — the Local VM could not be claimed for this turn (boot failed)"]
    : []),
  resolve: (value) => (typeof value === "object" && value !== null
    ? JSON.parse(JSON.stringify(value, (_key, entry) => (entry === "@lead" ? "b-lead" : entry)))
    : value === "@lead" ? "b-lead" : value),
};

const score = (assertion: Assertion) => evaluateAssertions([assertion], world)[0];

describe("evaluateAssertions", () => {
  it("counts activities and pins a gate answer HTTP status", () => {
    expect(score({ kind: "activityCount", bot: "auto", prefix: "error: computer unavailable", count: 1 }).pass).toBe(true);
    expect(score({ kind: "activityCount", bot: "auto", prefix: "error: computer unavailable", count: 2 }).pass).toBe(false);
    expect(score({ kind: "activityCount", bot: "auto", prefix: "Waiting for its turn", count: 1 }).pass).toBe(true);
    expect(score({ kind: "activityCount", bot: "chief", prefix: "Waiting", count: 0 }).pass).toBe(true);
    expect(score({ kind: "gateAnswer", of: "firstPoll", httpStatus: 200 }).pass).toBe(true);
    expect(score({ kind: "gateAnswer", of: "firstPoll", httpStatus: 401 }).pass).toBe(false);
    expect(score({ kind: "gateAnswer", of: "revokedPoll", httpStatus: 401 }).pass).toBe(true);
  });

  it("flags a queued send and passes an immediate one", () => {
    expect(score({ kind: "sendNotQueued", bot: "chief" }).pass).toBe(false);
    expect(score({ kind: "sendNotQueued", bot: "lead" }).pass).toBe(false);
  });

  it("matches tool calls with resolved bot references", () => {
    expect(score({ kind: "toolCalls", bot: "chief", equals: [{ arguments: { bot_ids: ["@lead"], request_key: "build" } }] }).pass).toBe(true);
    expect(score({ kind: "toolCalls", bot: "chief", equals: [] }).pass).toBe(false);
  });

  it("checks turn order, prompts, and the handoff tree shape", () => {
    expect(score({ kind: "turnOrder", bots: ["chief", "chief", "lead"] }).pass).toBe(true);
    expect(score({ kind: "systemPromptIncludes", bot: "chief", turn: 0, includes: "still outstanding" }).pass).toBe(true);
    expect(score({ kind: "systemPromptIncludes", bot: "chief", turn: 1, includes: "still outstanding" }).pass).toBe(false);
    expect(score({ kind: "handoffTree", equals: [{ bot: "lead", status: "completed", hasParent: true }] }).pass).toBe(true);
  });

  it("checks transcripts, gate answers, routine snapshots, and activities", () => {
    expect(score({ kind: "transcriptIncludes", bot: "chief", thread: "active", text: "export is done" }).pass).toBe(true);
    expect(score({ kind: "transcriptIncludes", bot: "lead", thread: "node", text: "done" }).pass).toBe(true);
    expect(score({ kind: "gateAnswer", of: "firstPoll", held: true, blockedReasonIncludes: "Another thread" }).pass).toBe(true);
    expect(score({ kind: "gateAnswer", of: "firstPoll", held: false }).pass).toBe(false);
    expect(score({ kind: "routineRunSnapshot", of: "heldRun", status: "queued", deferred: true }).pass).toBe(true);
    expect(score({ kind: "activitySeen", bot: "auto", namePrefix: "Waiting for its turn on this computer" }).pass).toBe(true);
    expect(score({ kind: "noActivityPrefix", bot: "auto", prefix: "Waiting" }).pass).toBe(false);
    expect(score({ kind: "noActivityPrefix", bot: "chief", prefix: "Waiting" }).pass).toBe(true);
  });
});
