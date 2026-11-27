import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../../types.ts";
import { goldenExportSchema, redactThread } from "./redact-thread.ts";

const SAMPLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "samples", "coordination-handoff.sample.json");

function sample() {
  return goldenExportSchema.parse(JSON.parse(readFileSync(SAMPLE_PATH, "utf8")));
}

describe("redactThread", () => {
  it("is deterministic and emits a schema-valid placeholder fixture", () => {
    const first = redactThread(sample());
    const second = redactThread(sample());
    expect(first.serialized).toBe(second.serialized);

    const scenario = scenarioSchema.parse(JSON.parse(first.serialized));
    expect(scenario.golden).toEqual({ from: "redacted-thread", redactor: 1 });
    expect(scenario.bots.map((bot) => bot.key)).toEqual(["bot1", "bot2"]);
    expect(scenario.steps[0]).toMatchObject({ kind: "send", bot: "bot1", text: "<user message 1>" });
    expect(scenario.steps.some((step) => step.kind === "waitForNodeStatus")).toBe(true);
    expect(scenario.assertions).toContainEqual({ kind: "turnOrder", bots: ["bot1", "bot2", "bot1"] });
    expect(first.report).toMatchObject({
      participants: 2,
      userMessages: 1,
      turnsDerived: 2,
      toolCallsDerived: 1,
      handoffsPinned: true,
      leaks: [],
    });
  });

  it("aborts before writing when pinned metadata would leak a pattern", () => {
    const poisoned = sample();
    poisoned.meta.title = "Escalate to brad@example-corp.com now";
    expect(() => redactThread(poisoned)).toThrow(/leaked sensitive patterns/);
  });

  it("aborts when any source string survives into the fixture", () => {
    const poisoned = sample();
    const secret = "Confidential Atlas Project";
    poisoned.meta.participants = [{ name: secret }];
    poisoned.meta.title = "Replay of " + secret;
    expect(() => redactThread(poisoned)).toThrow(/source string/);
  });

  it("omits handoff pins when the exported tree is not all-terminal", () => {
    const running = sample();
    running.handoffs = [
      { bot: "Atlas", status: "completed" },
      { bot: "Nova", status: "running", hasParent: true },
    ];
    const { report, serialized } = redactThread(running);
    expect(report.handoffsPinned).toBe(false);
    expect(report.handoffsOmittedReason).toMatch(/non-terminal/);
    const scenario = scenarioSchema.parse(JSON.parse(serialized));
    expect(scenario.steps.some((step) => step.kind === "waitForNodeStatus")).toBe(false);
    expect(scenario.assertions.some((assertion) => assertion.kind === "handoffTree")).toBe(false);
  });
});
