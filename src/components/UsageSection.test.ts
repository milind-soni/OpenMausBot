import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = {
  bots: [
    {
      id: "capture",
      name: "Capture",
      title: "Signal capture",
      description: "Collects source updates",
      color: "purple",
      avatarCrop: "glyph",
      hidden: false,
      modelSelection: { instanceId: "cursor" },
      tasks: [{
        threadId: "capture-thread",
        title: "Capture",
        createdAt: 1,
        usage: { input: 10, output: 5, costUsd: null, turns: 1, tokenTurns: 1 },
      }],
    },
    {
      id: "chief",
      name: "Chief",
      title: "Chief of staff",
      description: "Coordinates the work",
      chiefOfStaff: true,
      color: "green",
      avatarCrop: "glyph",
      hidden: false,
      modelSelection: { instanceId: "cursor" },
      tasks: [{
        threadId: "chief-thread",
        title: "Chief",
        createdAt: 1,
        usage: { input: 8, output: 4, costUsd: null, turns: 1, tokenTurns: 1 },
      }],
    },
  ],
  instances: [{ instanceId: "cursor", snapshot: { billing: "subscription" } }],
};

vi.mock("@/state/store", () => ({ useStore: () => ({ state }) }));

import { UsageSection } from "./UsageSection";

describe("UsageSection agent identity", () => {
  it("uses each agent's configured Agent Centipede glyph instead of a legacy color mascot", () => {
    const markup = renderToStaticMarkup(createElement(UsageSection));

    expect(markup).toContain("agent-glyph-avatar is-capture");
    expect(markup).toContain("agent-glyph-avatar is-coordinate");
    expect(markup).not.toContain("maus-avatar");
  });
});
