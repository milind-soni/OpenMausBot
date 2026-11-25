import { describe, expect, it } from "vitest";
import { createUsageAttribution } from "./usage-attribution.ts";
import type { UsageTrigger } from "./usage-ledger.ts";

const ADA = "ada@acme.test";

function world(running: Record<string, UsageTrigger> = {}) {
  const sections: Record<string, string> = { payroll: "Finance", helpdesk: " " };
  return createUsageAttribution({ section: (botId) => sections[botId], routineWriter: (id) => (id === "digest" ? ADA : undefined), threadTrigger: (threadId) => running[threadId] });
}
const row = (botId: string, trigger: UsageTrigger, turnId?: string, parent?: string, parentThread = "t") =>
  ({ botId, trigger, ...(turnId ? { turnId } : {}), ...(parent ? { parent: { threadId: parentThread, turnId: parent } } : {}) });

describe("who and which department a usage row was spent for", () => {
  it("stamps the bot's department as it is when booked, and none for a blank one", () => {
    const attribute = world();
    expect(attribute(row("payroll", { kind: "owner" }))).toMatchObject({ section: "Finance" });
    expect(attribute(row("helpdesk", { kind: "owner" }))).not.toHaveProperty("section");
  });

  it("names a routine's writer, and leaves a routine nobody on the team wrote as it was", () => {
    const attribute = world();
    expect(attribute(row("payroll", { kind: "routine", routineId: "digest" })).trigger).toEqual({ kind: "routine", routineId: "digest", email: ADA });
    expect(attribute(row("payroll", { kind: "routine", routineId: "other" })).trigger).toEqual({ kind: "routine", routineId: "other" });
  });

  it("follows delegated work back to the person whose turn started it, through teammates of teammates", () => {
    const attribute = world();
    attribute(row("payroll", { kind: "user", email: ADA }, "turn-ada"));
    expect(attribute(row("helpdesk", { kind: "bot", botId: "payroll" }, "turn-helper", "turn-ada")).trigger).toEqual({ kind: "bot", botId: "payroll", email: ADA });
    expect(attribute(row("payroll", { kind: "bot", botId: "helpdesk" }, "turn-deeper", "turn-helper")).trigger).toMatchObject({ email: ADA });
    expect(attribute(row("payroll", { kind: "bot" }, "turn-orphan", "turn-unknown")).trigger).toEqual({ kind: "bot" });
    expect(attribute(row("payroll", { kind: "owner" }, "turn-owner")).trigger).toEqual({ kind: "owner" });
  });

  it("names the person while the delegating turn is still running, and books a room member's turn it handed work to as theirs", () => {
    const attribute = world({ "t-ada": { kind: "user", email: ADA } });
    expect(attribute(row("helpdesk", { kind: "bot", botId: "payroll" }, "turn-child", "turn-ada-running", "t-ada")).trigger).toEqual({ kind: "bot", botId: "payroll", email: ADA });
    expect(attribute(row("helpdesk", { kind: "owner" }, "turn-room", "turn-ada-running", "t-ada")).trigger).toEqual({ kind: "owner", email: ADA });
    expect(attribute(row("helpdesk", { kind: "owner" }, "turn-plain")).trigger).toEqual({ kind: "owner" });
  });
});
