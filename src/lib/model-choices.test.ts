import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { choiceIsSelected, modelChoices } from "./model-choices";

const antigravity = {
  instanceId: "google",
  driverKind: "antigravityAgent",
  displayName: "Google Gemini (Antigravity)",
  snapshot: { state: "available", version: "1.4.3" },
  models: { default: "gemini-3.8-flash", options: [{
    id: "gemini-3.8-flash", label: "Gemini 3.8 Flash",
    variants: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }],
  }] },
} as InstanceInfo;

describe("Antigravity model choices", () => {
  it("presents each advertised thinking level as a selectable model row", () => {
    const choices = modelChoices(antigravity, antigravity.models.options);
    expect(choices.map((choice) => choice.label)).toEqual([
      "Gemini 3.8 Flash · Low", "Gemini 3.8 Flash · Medium", "Gemini 3.8 Flash · High",
    ]);
    expect(choiceIsSelected(choices[1]!, { instanceId: "google", model: "gemini-3.8-flash", variant: "medium" })).toBe(true);
  });
});
