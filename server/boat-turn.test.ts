import { describe, expect, it } from "vitest";

import { boatTurnLifecycleAction } from "./boat.ts";

describe("Boat turn lifecycle", () => {
  it("keeps Auto mutation-free even when the box-native engine can mount Boat", () => {
    const auto = { explicitCloud: false, canMount: true };

    expect(boatTurnLifecycleAction({ ...auto, state: null })).toBe("none");
    expect(boatTurnLifecycleAction({ ...auto, state: "archived" })).toBe("none");
    expect(boatTurnLifecycleAction({ ...auto, state: "provisioning" })).toBe("none");
    expect(boatTurnLifecycleAction({ ...auto, state: "running" })).toBe("attach");
  });

  it("allows only explicit Cloud to provision or wake Boat", () => {
    const cloud = { explicitCloud: true, canMount: true };

    expect(boatTurnLifecycleAction({ ...cloud, state: null })).toBe("provision");
    expect(boatTurnLifecycleAction({ ...cloud, state: "archived" })).toBe("wake");
    expect(boatTurnLifecycleAction({ ...cloud, state: "ready" })).toBe("attach");
    expect(boatTurnLifecycleAction({ ...cloud, canMount: false, state: "ready" })).toBe("none");
  });
});
