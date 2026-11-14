import { expect, it } from "vitest";
import { modelEffortLevels } from "./model-effort";

it("intersects model and engine levels without filling gaps or treating an empty list as unknown", () => {
  const engine = { capabilities: { effortLevels: ["low", "medium", "high", "max"] as const }, models: { options: [
    { id: "limited", effortLevels: ["low", "high", "xhigh"] as const }, { id: "no-effort", effortLevels: [] }, { id: "unknown" },
  ] } };
  expect(modelEffortLevels("limited", engine)).toEqual(["low", "high"]);
  expect(modelEffortLevels("no-effort", engine)).toEqual([]);
  expect(modelEffortLevels("unknown", engine)).toEqual(engine.capabilities.effortLevels);
  expect(modelEffortLevels("limited", { models: engine.models })).toEqual([]);
});
