import { describe, expect, it } from "vitest";
import type { BotRecord } from "../store.ts";
import { createDelegatedLevel } from "./delegated-level.ts";

const chief = { id: "chief", chiefOfStaff: true, approvalMode: "full", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
const member = { id: "member", approvalMode: "ask", modelSelection: { instanceId: "native", model: "fixture" } } as BotRecord;
const resolve = createDelegatedLevel({ sourceApprovalMode: () => "full", driverKind: () => "claudeAgent" });

describe("delegated native grant boundaries", () => {
  it.each(["person", "routine"] as const)("keeps a Chief's grant for %s lineage", origin => {
    expect(resolve(chief, "source", member, "ask", origin)).toBe("full");
  });
  it("keeps outside work at the recipient's own level", () => {
    expect(resolve(chief, "source", member, "ask", "outside")).toBeNull();
  });
  it.each(["person", "routine", "outside"] as const)("never elevates Custom when peer dispatch projects it to Auto (%s)", origin => {
    expect(resolve(chief, "source", { ...member, approvalMode: "custom" }, "auto", origin)).toBeNull();
  });
});
