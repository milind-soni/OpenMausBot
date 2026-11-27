import { describe, expect, it } from "vitest";
import { xResearchAction, type CloudPlanView } from "./cloud-plan";

describe("xResearchAction", () => {
  it("tells a paying desktop it is connecting, a signed-out one to sign in, and a free one to get a plan", () => {
    expect(xResearchAction({ kind: "paid", label: "Pro", checking: false })).toBe("connecting");
    expect(xResearchAction({ kind: "signed-out" })).toBe("sign-in");
    expect(xResearchAction({ kind: "reauth", label: "Pro", reason: "expired" })).toBe("sign-in");
    expect(xResearchAction({ kind: "free" })).toBe("get-pro");
  });

  it("offers nothing where buying is not right or the state is not known, and without a desktop bridge", () => {
    const quiet: CloudPlanView[] = [{ kind: "unknown" }, { kind: "connecting" }, { kind: "attention", label: "Pro" }, { kind: "purchase", label: "Pro" }, { kind: "unverified", label: null }];
    for (const view of quiet) expect(xResearchAction(view), view.kind).toBeNull();
    expect(xResearchAction(null)).toBeNull();
  });
});
