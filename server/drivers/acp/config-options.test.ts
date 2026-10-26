import { describe, expect, it } from "vitest";
import { acpModelOption, acpVariantOption, offeredModels } from "./config-options.ts";

describe("ACP model and reasoning options", () => {
  it("preserves grouped model labels and providers and ignores duplicate or malformed IDs", () => {
    const result = { configOptions: [{ type: "select", id: "route", category: "model", currentValue: "zai/flash", options: [
      { name: "Z.ai", options: [{ value: "zai/flash", name: "GLM Flash" }, { value: "zai/max", name: "GLM" }] },
      { value: "zai/flash", name: "Duplicate" }, { value: "" }, null,
    ] }] };
    expect(acpModelOption(result)).toEqual({ configId: "route", currentValue: "zai/flash", options: [
      { id: "zai/flash", label: "GLM Flash", provider: "Z.ai" }, { id: "zai/max", label: "GLM", provider: "Z.ai" },
    ] });
    expect(offeredModels(result, "route")).toEqual(["zai/flash", "zai/max"]);
  });

  it("supports legacy model metadata without claiming a config setter", () => {
    expect(acpModelOption({ models: { currentModelId: "fast", availableModels: [
      { modelId: "fast", name: "Fast", provider: "local" }, { modelId: "deep" }, { modelId: "fast" }, {},
    ] } })).toEqual({ currentValue: "fast", options: [
      { id: "fast", label: "Fast", provider: "local" }, { id: "deep", label: "deep" },
    ] });
    expect(acpModelOption({})).toBeUndefined();
  });

  it.each(["effort", "reasoning_effort", "thought_level"])("preserves %s native values", (id) => {
    expect(acpVariantOption({ configOptions: [{ type: "select", id, currentValue: "enabled", options: [
      { value: "enabled", name: "Model default" }, { name: "Thinking", options: [{ value: "max", name: "Maximum" }] },
      { value: "disabled", name: "Off" },
    ] }] })).toEqual({ configId: id, currentValue: "enabled", options: [
      { id: "enabled", label: "Model default" }, { id: "max", label: "Maximum" }, { id: "disabled", label: "Off" },
    ] });
  });

  it("does not invent reasoning options for a model without them", () => {
    expect(acpVariantOption({ configOptions: [{ type: "select", id: "model", options: [{ value: "fast" }] }] })).toBeUndefined();
    expect(acpVariantOption({ configOptions: [{ type: "boolean", id: "effort", currentValue: true }] })).toBeUndefined();
  });
});
