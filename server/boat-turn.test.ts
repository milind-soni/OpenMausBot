import { describe, expect, it } from "vitest";

import { boatTurnLifecycleAction } from "./boat.ts";

describe("Boat turn lifecycle", () => {
  it("attaches a ready Boat, wakes a sleeping one and creates a missing one", () => {
    expect(boatTurnLifecycleAction(null)).toBe("provision");
    expect(boatTurnLifecycleAction("archived")).toBe("wake");
    expect(boatTurnLifecycleAction("ready")).toBe("attach");
    expect(boatTurnLifecycleAction("running")).toBe("attach");
  });
});
