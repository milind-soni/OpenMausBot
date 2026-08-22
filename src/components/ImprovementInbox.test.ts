import { describe, expect, it } from "vitest";

import type { AgentGraph } from "../../shared/agent-graphs";
import { verificationPathInputs } from "./ImprovementInbox";

const graph = {
  nodes: [
    { id: "inspect" },
    { id: "implement" },
    { id: "verify" },
  ],
} as AgentGraph;

describe("Improvement Inbox verification evidence", () => {
  it("emits trimmed relative paths in graph-node order and withholds empty nodes", () => {
    expect(verificationPathInputs(graph, {
      verify: "  receipts/verify.json  ",
      inspect: "src/index.ts",
      implement: "   ",
    })).toEqual([
      { nodeId: "inspect", relativePath: "src/index.ts" },
      { nodeId: "verify", relativePath: "receipts/verify.json" },
    ]);
  });
});
