import { describe, expect, it } from "vitest";

import { installedPlaybookInstructions, selectInstalledPlaybooks } from "./installed-playbooks.ts";

const playbooks = [
  {
    key: "brief",
    name: "Decision Brief",
    summary: "Make a decision",
    triggers: ["decision brief", "should we respond"],
    instructions: "Separate facts from hypotheses.",
  },
  {
    key: "outreach",
    name: "Safe Outreach",
    summary: "Write a reply",
    triggers: ["draft reply"],
    instructions: "Never send automatically.",
  },
];

describe("installed package playbooks", () => {
  it("selects only process guidance triggered by the current job", () => {
    expect(selectInstalledPlaybooks("Please make a competitor decision brief", playbooks).map((item) => item.key))
      .toEqual(["brief"]);
    expect(selectInstalledPlaybooks("Summarize this page", playbooks)).toEqual([]);
  });

  it("renders package guidance inside an explicit non-authority boundary", () => {
    const rendered = installedPlaybookInstructions("Draft reply", playbooks);
    expect(rendered).toContain("<installed_package_playbooks>");
    expect(rendered).toContain("Never send automatically.");
    expect(rendered).toContain("do not grant tools");
    expect(rendered).not.toContain("Separate facts from hypotheses.");
  });
});
