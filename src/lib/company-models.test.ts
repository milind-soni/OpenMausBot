import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import { companyInstanceFor, isCompanyInstance, planCompanySwitch, selectionCanRun } from "./company-models";

const managed = { organizationId: "fixture-org", organizationName: "Fixture Company" };
function instance(instanceId: string, driverKind: string, snapshot: InstanceInfo["snapshot"], extra: Partial<InstanceInfo> = {}): InstanceInfo {
  return { instanceId, driverKind, displayName: instanceId, snapshot, models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] }, ...extra };
}
const companyClaude = instance("company.fixture.anthropic", "claudeAgent", { state: "available", authenticated: true }, { readOnly: true, managed, displayName: "Company · Fixture Company · Claude" });
const companyRouter = instance("company.fixture.openrouter", "openai-compat", { state: "available", authenticated: true }, { readOnly: true, managed, displayName: "Company · Fixture Company · OpenRouter" });
const signedOutClaude = instance("claude", "claudeAgent", { state: "available", authenticated: false }, {
  models: { default: "sonnet", options: [{ id: "sonnet", label: "Sonnet" }, { id: "local/qwen", label: "Qwen", custom: true }] },
});
const workingCodex = instance("codex", "codex", { state: "available", authenticated: true });
const missingCli = instance("grok", "grokAgent", { state: "unavailable", reason: "grok CLI not found" });
function bot(id: string, instanceId: string, extra: Partial<Bot> = {}): Bot {
  return { id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true, color: "green", unread: false, messages: [],
    modelSelection: { instanceId, model: instanceId === "claude" ? "sonnet" : `${instanceId}-default` }, ...extra } as Bot;
}

describe("Company switch planning", () => {
  it("recognises only organisation-owned instances as Company", () => {
    expect(isCompanyInstance(companyClaude)).toBe(true);
    expect(isCompanyInstance({ ...companyClaude, managed: undefined })).toBe(false);
    expect(isCompanyInstance({ ...workingCodex, instanceId: "company.personal.anthropic" })).toBe(false);
    expect(companyInstanceFor([workingCodex, companyRouter, companyClaude], "anthropic")).toBe(companyClaude);
    expect(companyInstanceFor([workingCodex], "anthropic")).toBeUndefined();
  });

  it("counts only bots whose engine is missing, unavailable, signed out or refused, never a working or archived one", () => {
    const instances = [signedOutClaude, workingCodex, missingCli, companyRouter, companyClaude];
    const bots = [
      bot("signed-out", "claude"), bot("working", "codex"), bot("missing", "deleted-instance"), bot("setup", ""),
      bot("unavailable", "grok"), bot("custom-model", "claude", { modelSelection: { instanceId: "claude", model: "local/qwen" } }),
      bot("already-company", companyRouter.instanceId), bot("archived", "deleted-instance", { hidden: true }),
    ];
    const plan = planCompanySwitch(bots, instances);
    expect(plan.target).toBe(companyClaude);
    expect(plan.bots.map((row) => row.id)).toEqual(["signed-out", "missing", "setup", "unavailable"]);
    expect(plan.needsAsk).toEqual([]);
  });

  it("leaves a bot alone when its selected thread still runs, because the PATCH moves both", () => {
    const threaded = bot("threaded", "deleted-instance", { tasks: [{ threadId: "threaded-thread", title: "", modelSelection: { instanceId: "codex", model: "codex-default" } }] as Bot["tasks"] });
    expect(planCompanySwitch([threaded], [workingCodex, companyClaude]).bots).toEqual([]);
  });

  it("treats a bot the organisation's policy refuses as unable to run, and never targets a refused Company engine", () => {
    const refused = { organizationName: "Fixture Company", reason: "Fixture Company allows only company models on this computer." };
    const plan = planCompanySwitch([bot("personal", "codex")], [{ ...workingCodex, policy: refused }, { ...companyClaude, policy: refused }, companyRouter]);
    expect(plan.target).toBe(companyRouter);
    expect(plan.bots.map((row) => row.id)).toEqual(["personal"]);
    expect(planCompanySwitch([bot("personal", "codex")], [{ ...workingCodex, policy: refused }, { ...companyRouter, policy: refused }]))
      .toEqual({ bots: [], needsAsk: [] });
  });

  it("offers nothing when no Company model can run yet", () => {
    const companyMissingCli = { ...companyClaude, snapshot: { state: "unavailable" as const, reason: "claude CLI not found" } };
    expect(planCompanySwitch([bot("signed-out", "claude")], [signedOutClaude, companyMissingCli])).toEqual({ bots: [], needsAsk: [] });
  });

  it("keeps elevated-permission bots out of the switch when the engine would change", () => {
    const full = bot("full", "deleted-instance", { approvalMode: "full" });
    const fullSameEngine = bot("full-claude", "claude", { approvalMode: "full" });
    const plan = planCompanySwitch([full, fullSameEngine, bot("ask", "claude")], [signedOutClaude, companyClaude]);
    expect(plan.bots.map((row) => row.id)).toEqual(["full-claude", "ask"]);
    expect(plan.needsAsk.map((row) => row.id)).toEqual(["full"]);
  });

  it("treats a signed-out engine's custom models as still able to run", () => {
    expect(selectionCanRun({ instanceId: "claude", model: "local/qwen" }, [signedOutClaude])).toBe(true);
    expect(selectionCanRun({ instanceId: "claude", model: "sonnet" }, [signedOutClaude])).toBe(false);
  });
});
