import { describe, expect, it } from "vitest";
import type { BotRecord } from "../store.ts";
import { createDelegatedLevel } from "./delegated-level.ts";

const chief = { id: "chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
const member = { id: "member", approvalMode: "ask", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
const resolve = createDelegatedLevel({ sourceApprovalMode: () => "full", driverKind: () => "claudeAgent" });

describe("a Chief's level flowing to a teammate", () => {
  it("raises the teammate to the Chief's level", () => {
    expect(resolve(chief, "source", member, "ask")).toBe("full");
  });
  it("never raises a bot on Custom, which a peer turn reads as Auto", () => {
    expect(resolve(chief, "source", { ...member, approvalMode: "custom" }, "auto")).toBeNull();
  });
  it("never raises the Chief itself", () => {
    expect(resolve(chief, "source", chief, "ask")).toBeNull();
  });
});
