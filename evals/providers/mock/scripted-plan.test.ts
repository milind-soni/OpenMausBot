import { describe, expect, it } from "vitest";
import { buildScriptedPlan, scriptedToolCall } from "./scripted-plan.ts";
import { scenarioSchema } from "../../types.ts";

const base = {
  id: "plan-fixture",
  title: "fixture",
  behavior: "fixture",
  world: "coordination",
  bots: [
    {
      key: "chief",
      name: "Clive",
      turns: [
        {
          steps: [{ arguments: { bot_ids: ["@lead"], request_key: "build", message: "go" }, expectError: true }],
          reply: "assigned",
          gate: "hold",
        },
      ],
    },
    { key: "lead", name: "Lead", turns: [{ reply: "done" }] },
  ],
  steps: [],
  assertions: [],
};

describe("buildScriptedPlan", () => {
  it("keys turns by live bot id and resolves @bot references inside arguments", () => {
    const ids: Record<string, string> = { chief: "bot-1", lead: "bot-2" };
    const plan = buildScriptedPlan(
      scenarioSchema.parse(base),
      (ref) => ids[ref.replace("@", "")],
      (gate) => "/gates/" + gate,
    ) as Record<string, any>;
    expect(Object.keys(plan)).toEqual(["bot-1", "bot-2"]);
    const chief = plan["bot-1"].turns[0];
    expect(chief.steps[0].arguments.bot_ids).toEqual(["bot-2"]);
    expect(chief.steps[0].arguments.request_key).toBe("build");
    expect(chief.steps[0].expectError).toBe(true);
    expect(chief.steps[0].tool).toBeUndefined();
    expect(chief.gateFile).toBe("/gates/hold");
    expect(chief.reply).toBe("assigned");
    expect(plan["bot-2"].turns[0].reply).toBe("done");
  });

  it("keeps non-bot strings untouched so prompts stay verbatim", () => {
    const call = scriptedToolCall({ arguments: { message: "email@example.com stays" } }, () => {
      throw new Error("no refs expected");
    });
    expect(call.arguments).toEqual({ message: "email@example.com stays" });
  });
});
