import { describe, expect, it } from "vitest";

import { blankModelSelection, normalizedTeamSetupPlan } from "./agents-call.ts";

describe("blankModelSelection", () => {
  it("reads a blank model choice as the default", () => {
    expect(blankModelSelection(undefined)).toBeUndefined();
    expect(blankModelSelection({})).toBeUndefined();
    expect(blankModelSelection({ instanceId: "", model: "", effort: "", variant: "" })).toBeUndefined();
  });

  it("keeps the ids it is given and drops blank optional ones", () => {
    expect(blankModelSelection({ instanceId: " codex ", model: " gpt-5 ", effort: "", variant: "" }))
      .toEqual({ instanceId: "codex", model: "gpt-5" });
    expect(blankModelSelection({ instanceId: "codex", model: "gpt-5", variant: "high" }))
      .toEqual({ instanceId: "codex", model: "gpt-5", variant: "high" });
    // A model without an instance is still refused by the server, not turned into the default.
    expect(blankModelSelection({ instanceId: "", model: "gpt-5" })).toEqual({ instanceId: "", model: "gpt-5" });
  });
});

describe("normalizedTeamSetupPlan", () => {
  it("drops the update-only botId from a create entry", () => {
    const plan = normalizedTeamSetupPlan({
      reason: "Two specialists",
      operations: [
        { action: "create", key: "writer", botId: "bogus", fields: { name: "Writer" } },
        { action: "update", botId: "bot-1", fields: { chiefOfStaff: true } },
      ],
    });
    const [create, update] = plan.operations as Array<Record<string, unknown>>;
    expect(create).toEqual({ action: "create", key: "writer", fields: { name: "Writer" } });
    expect(update).toEqual({ action: "update", botId: "bot-1", fields: { chiefOfStaff: true } });
  });

  it("drops a blank model choice from either entry", () => {
    const plan = normalizedTeamSetupPlan({
      reason: "Setup",
      operations: [
        { action: "create", key: "a", fields: { name: "A", modelSelection: { instanceId: "", model: "", effort: "" } } },
        { action: "update", botId: "bot-2", fields: { modelSelection: { instanceId: "codex", model: "gpt-5", variant: "" } } },
      ],
    });
    const [create, update] = plan.operations as Array<Record<string, unknown>>;
    expect(create.fields).toEqual({ name: "A" });
    expect(update.fields).toEqual({ modelSelection: { instanceId: "codex", model: "gpt-5" } });
  });
});
