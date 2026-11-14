// The row a transcript gets when an automatic approval did not land. The
// words moved here from server/index.ts unchanged; this pins them.
import { describe, expect, it } from "vitest";

import { undeliveredApprovalTool } from "./auto-approve.ts";

describe("undeliveredApprovalTool", () => {
  it("names the grant the provider refused", () => {
    expect(undeliveredApprovalTool("rejected", "full-access")).toEqual({ name: "The provider rejected this action despite Full access.", ok: false });
    expect(undeliveredApprovalTool("rejected", "command-allowlist")).toEqual({ name: "The provider rejected this action despite the saved command permission.", ok: false });
    expect(undeliveredApprovalTool("rejected", "tool-allowlist")).toEqual({ name: "The provider rejected this action despite the saved tool permission.", ok: false });
    // any other grant reads as Full access, as it did in the fold
    expect(undeliveredApprovalTool("rejected", "web-search").name).toBe("The provider rejected this action despite Full access.");
  });

  it("is a failed turn when the answer could not be delivered at all", () => {
    for (const outcome of ["failed", "answered"] as const) {
      expect(undeliveredApprovalTool(outcome, "full-access")).toEqual({
        name: "error: could not deliver approval to the provider; retry the task after reconnecting.",
        ok: false,
      });
    }
  });
});
