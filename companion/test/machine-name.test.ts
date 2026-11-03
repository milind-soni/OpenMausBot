import { describe, expect, it } from "vitest";

import { machineNameFromConfig } from "../src/machine-name.ts";

describe("machine name", () => {
  it("uses the name set in Settings over the profile name", () => {
    expect(machineNameFromConfig({ computerName: " AdamPC ", profile: { name: "Adam" } })).toBe("AdamPC");
  });

  it("falls back to the owner's profile name", () => {
    expect(machineNameFromConfig({ computerName: "", profile: { name: "Adam" } })).toBe("Adam's computer");
    expect(machineNameFromConfig({ profile: { name: "Adam" } })).toBe("Adam's computer");
  });

  it("is empty when neither is set or the reply is not a config", () => {
    expect(machineNameFromConfig({ computerName: "  ", profile: { name: "" } })).toBe("");
    expect(machineNameFromConfig(null)).toBe("");
    expect(machineNameFromConfig({ computerName: 7, profile: { name: ["x"] } })).toBe("");
  });
});
