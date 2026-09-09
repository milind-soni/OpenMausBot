import { describe, expect, it } from "vitest";

import { boxTurnLifecycleAction } from "./box.ts";

describe("Box turn lifecycle", () => {
  it("keeps Auto mutation-free even when the box-native engine can mount Box", () => {
    const auto = { explicitCloud: false, canMount: true };

    expect(boxTurnLifecycleAction({ ...auto, state: null })).toBe("none");
    expect(boxTurnLifecycleAction({ ...auto, state: "archived" })).toBe("none");
    expect(boxTurnLifecycleAction({ ...auto, state: "provisioning" })).toBe("none");
    expect(boxTurnLifecycleAction({ ...auto, state: "running" })).toBe("attach");
  });

  it("allows only explicit Cloud to provision or wake Box", () => {
    const cloud = { explicitCloud: true, canMount: true };

    expect(boxTurnLifecycleAction({ ...cloud, state: null })).toBe("provision");
    expect(boxTurnLifecycleAction({ ...cloud, state: "archived" })).toBe("wake");
    expect(boxTurnLifecycleAction({ ...cloud, state: "ready" })).toBe("attach");
    expect(boxTurnLifecycleAction({ ...cloud, canMount: false, state: "ready" })).toBe("none");
  });
});
