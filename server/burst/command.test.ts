import { describe, expect, it } from "vitest";

import { expandBurstTurnText, parseBurstCommand } from "./command.ts";

describe("/burst", () => {
  it("reads a request", () => {
    expect(parseBurstCommand("/burst research these 20 companies")).toEqual({ request: "research these 20 companies" });
    expect(parseBurstCommand("  /BURST\nline one\nline two ")).toEqual({ request: "line one\nline two" });
  });

  it("leaves other text alone", () => {
    expect(parseBurstCommand("burst this")).toBeNull();
    expect(parseBurstCommand("/burstable")).toBeNull();
    expect(expandBurstTurnText("hello")).toBe("hello");
  });

  it("tells the bot to propose and not to do the work", () => {
    const text = expandBurstTurnText("/burst research Acme and Globex");
    expect(text).toContain("research Acme and Globex");
    expect(text).toContain("Call the burst tool");
  });

  it("asks when there is nothing to run", () => {
    expect(expandBurstTurnText("/burst")).toContain("without a request");
  });
});
