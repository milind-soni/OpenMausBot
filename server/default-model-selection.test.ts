import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { selectDefaultModelSelection, withNewBotEffort } from "./default-model-selection.ts";
import { ManagedDesktopPolicy } from "./managed-policy.ts";

const codex = {
  instanceId: "codex",
  driverKind: "codex",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: {
    default: "codex-default",
    options: [{ id: "codex-default", label: "Default" }, { id: "selected-model", label: "Selected" }],
  } satisfies ModelCatalog,
  capabilities: { effortLevels: ["low", "high"] as const },
};
const claude = {
  instanceId: "claude",
  driverKind: "claudeAgent",
  snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
  models: { default: "claude-default", options: [{ id: "claude-default", label: "Claude" }] },
};

describe("new bot default model selection", () => {
  it("accepts a configured API-key provider", () => {
    const instance = { ...codex, instanceId: "mistral", driverKind: "mistral", access: "api" as const };
    const preferred = { instanceId: "mistral", model: "selected-model" };
    expect(selectDefaultModelSelection([instance], preferred)).toEqual(preferred);
  });
  it("preserves an intentional variant for ACP validation, including variants absent from the preview catalog", () => {
    const preferred = { instanceId: "codex", model: "selected-model", variant: "default" };
    expect(selectDefaultModelSelection([{ ...codex, capabilities: { modelVariants: true } }], preferred))
      .toEqual(preferred);
    expect(selectDefaultModelSelection([codex], preferred)).toEqual({ instanceId: "", model: "" });
    expect(preferred.variant).toBe("default");
  });
  it.each(["low", "high"] as const)("honors the configured provider, model, and supported %s effort ahead of the Claude preference", (effort) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort };
    const selection = selectDefaultModelSelection([claude, codex], preferred);
    expect(selection).toEqual(preferred);
    expect(selection).not.toBe(preferred);
  });

  it.each([
    { label: "missing capabilities", capabilities: undefined },
    { label: "no effort control", capabilities: {} },
    { label: "empty effort list", capabilities: { effortLevels: [] } },
    { label: "changed effort support", capabilities: { effortLevels: ["low"] as const } },
  ])("omits stale effort for $label without changing the provider, model, or saved preference", ({ capabilities }) => {
    const preferred = { instanceId: "codex", model: "selected-model", effort: "high" as const };
    const selection = selectDefaultModelSelection([
      { ...claude, capabilities: { effortLevels: ["high"] } },
      { ...codex, capabilities },
    ], preferred);
    expect(selection).toEqual({ instanceId: "codex", model: "selected-model" });
    expect(selection).not.toHaveProperty("effort");
    expect(preferred.effort).toBe("high");
  });

  it("accepts the provider default even when it is not repeated in its options", () => {
    expect(selectDefaultModelSelection(
      [{ ...codex, models: { default: "codex-default", options: [] } }],
      { instanceId: "codex", model: "codex-default" },
    )).toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it.each([
    { label: "missing provider", instances: [claude] },
    { label: "unavailable provider", instances: [claude, { ...codex, snapshot: { state: "unavailable" as const } }] },
    { label: "signed-out provider", instances: [claude, { ...codex, snapshot: { state: "available" as const, authenticated: false } }] },
    { label: "removed model", instances: [claude, { ...codex, models: { default: "new-model", options: [] } }] },
  ])("returns setup for a saved $label without changing provider", ({ instances }) => {
    expect(selectDefaultModelSelection(instances, { instanceId: "codex", model: "selected-model" }))
      .toEqual({ instanceId: "", model: "" });
  });

  it("keeps the existing Claude preference when no default was saved", () => {
    expect(selectDefaultModelSelection([codex, claude])).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([codex])).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(selectDefaultModelSelection([])).toEqual({ instanceId: "", model: "" });
  });
});

describe("new bot default model selection while enrolled in an organisation", () => {
  const signedOut = { ...claude, instanceId: "personal-claude", snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  const companyClaude = { ...claude, instanceId: "company.fixture.anthropic", models: { default: "company-claude", options: [{ id: "company-claude", label: "Company" }] } };
  const companyRouter = {
    instanceId: "company.fixture.openrouter", driverKind: "openai-compat",
    snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
    models: { default: "company/router", options: [{ id: "company/router", label: "Router" }] },
  };
  const company = (instanceId: string) => instanceId.startsWith("company.");

  it("picks a Company model that can run over an installed but signed-out personal Claude", () => {
    expect(selectDefaultModelSelection([signedOut, companyClaude], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
    // Claude first among Company models, whatever order they are listed in.
    expect(selectDefaultModelSelection([signedOut, companyRouter, companyClaude], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
    expect(selectDefaultModelSelection([signedOut, companyRouter], undefined, { company }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
  });

  it("keeps a signed-in personal engine, so billing stays the person's choice", () => {
    expect(selectDefaultModelSelection([companyClaude, claude], undefined, { company }))
      .toEqual({ instanceId: "claude", model: "claude-default" });
    expect(selectDefaultModelSelection([signedOut, companyClaude, codex], undefined, { company }))
      .toEqual({ instanceId: "codex", model: "codex-default" });
  });

  it("falls back to today's choice when nothing can run yet", () => {
    const companyMissingCli = { ...companyClaude, snapshot: { state: "unavailable", reason: "claude CLI not found" } satisfies ProviderSnapshot };
    expect(selectDefaultModelSelection([signedOut, companyMissingCli], undefined, { company }))
      .toEqual({ instanceId: "personal-claude", model: "claude-default" });
  });

  it("is exactly today's choice without an enrolment", () => {
    for (const instances of [[signedOut, codex], [codex, signedOut], [codex], [signedOut], []]) {
      expect(selectDefaultModelSelection(instances, undefined, {})).toEqual(selectDefaultModelSelection(instances));
      expect(selectDefaultModelSelection(instances, undefined, { company, refusal: () => undefined })).toEqual(selectDefaultModelSelection(instances));
    }
    // Today a signed-out Claude still wins over a signed-in Codex.
    expect(selectDefaultModelSelection([codex, signedOut], undefined, { company })).toEqual({ instanceId: "personal-claude", model: "claude-default" });
  });

  it("never picks an engine the organisation's policy refuses", () => {
    // companyModelsOnly: every personal instance is refused.
    const companyOnly = (instance: { instanceId: string }) => company(instance.instanceId) ? undefined : "Fixture Company allows only company models on this computer.";
    expect(selectDefaultModelSelection([claude, codex, companyRouter], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    expect(selectDefaultModelSelection([claude, codex], undefined, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
    // An allow-list without Claude skips Claude, personal or Company.
    const noClaude = (instance: { driverKind: string }) => instance.driverKind === "claudeAgent" ? "Fixture Company does not allow the Claude engine on this computer." : undefined;
    expect(selectDefaultModelSelection([claude, companyClaude, companyRouter], undefined, { company, refusal: noClaude }))
      .toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    // A saved choice the organisation refuses sends new bots to setup, never elsewhere.
    expect(selectDefaultModelSelection([claude, companyRouter], { instanceId: "claude", model: "claude-default" }, { company, refusal: companyOnly }))
      .toEqual({ instanceId: "", model: "" });
  });
});

// The server's own wiring, not a copy: run index.ts's actual defaultSelection
// and policyModelRefusal against a synthetic registry, enrolment and policy.
describe("new bot default model selection wiring in index.ts", () => {
  // Windows checkouts may use CRLF; match on normalised line endings.
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const extract = (signature: string) => {
    const start = source.indexOf(`\n${signature}`), end = source.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    return source.slice(start + 1, end + 2);
  };
  const code = ts.transpileModule(`${extract("function policyModelRefusal(")}\n${extract("async function defaultSelection(")}`,
    { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  const companyRouter = {
    instanceId: "company.fixture.openrouter", driverKind: "openai-compat",
    snapshot: { state: "available", authenticated: true } satisfies ProviderSnapshot,
    models: { default: "company/router", options: [{ id: "company/router", label: "Router" }] },
  };
  const companyClaude = { ...claude, instanceId: "company.fixture.anthropic", models: { default: "company-claude", options: [{ id: "company-claude", label: "Company" }] } };
  const signedOut = { ...claude, snapshot: { state: "available", authenticated: false } satisfies ProviderSnapshot };
  function server(instances: unknown[], { enrolled = false, companyModelsOnly = false, saved }: { enrolled?: boolean; companyModelsOnly?: boolean; saved?: ModelSelection } = {}) {
    const managedPolicy = new ManagedDesktopPolicy();
    if (companyModelsOnly) managedPolicy.apply({ organizationId: "11111111-1111-4111-8111-111111111111", organizationName: "Fixture Company", expiresAt: Date.now() + 60_000,
      version: 1, companyModelsOnly: true, allowedEngines: "all", mcp: { allowCustom: true, allowlist: [] },
      computers: { thisComputer: true, localVm: true, box: true, vps: true }, remoteAccess: true });
    const managedDesktop = { owns: (instanceId: string) => enrolled && instanceId.startsWith("company.") };
    const defaultSelection = new Function("hostedModels", "cfg", "registry", "managedDesktop", "managedPolicy", "BUILT_IN_DRIVERS", "selectDefaultModelSelection",
      `${code}; return defaultSelection;`)(undefined, { defaultModelSelection: saved }, { describe: async () => instances }, managedDesktop, managedPolicy,
      [{ driverKind: "claudeAgent", metadata: { displayName: "Claude" } }], selectDefaultModelSelection) as () => Promise<ModelSelection>;
    return { defaultSelection, close: () => managedPolicy.close() };
  }

  it("passes the enrolment into the choice, and is today's choice without one", async () => {
    const notEnrolled = server([signedOut, companyClaude]);
    await expect(notEnrolled.defaultSelection()).resolves.toEqual({ instanceId: "claude", model: "claude-default" });
    const enrolled = server([signedOut, companyClaude], { enrolled: true });
    await expect(enrolled.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.anthropic", model: "company-claude" });
  });

  it("passes the organisation's policy into the choice", async () => {
    const policy = server([claude, companyRouter], { enrolled: true, companyModelsOnly: true });
    await expect(policy.defaultSelection()).resolves.toEqual({ instanceId: "company.fixture.openrouter", model: "company/router" });
    const saved = server([claude, companyRouter], { enrolled: true, companyModelsOnly: true, saved: { instanceId: "claude", model: "claude-default" } });
    await expect(saved.defaultSelection()).resolves.toEqual({ instanceId: "", model: "" });
    policy.close(); saved.close();
  });
});

describe("new bot effort default", () => {
  const selection: ModelSelection = { instanceId: "codex", model: "codex-default" };

  it("adds the workspace effort when the engine offers it", () => {
    expect(withNewBotEffort(selection, "high", ["low", "high"])).toEqual({ ...selection, effort: "high" });
  });

  it("keeps the caller's explicit effort or model variant", () => {
    expect(withNewBotEffort({ ...selection, effort: "low" }, "high", ["low", "high"])).toEqual({ ...selection, effort: "low" });
    const variant = { instanceId: "opencodeGo", model: "provider/model", variant: "minimal" };
    expect(withNewBotEffort(variant, "high", ["high"])).toEqual(variant);
  });

  it("sends no level when none is configured or the engine does not offer it", () => {
    expect(withNewBotEffort(selection, undefined, ["high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "max", ["low", "high"])).toEqual(selection);
    expect(withNewBotEffort(selection, "high", undefined)).toEqual(selection);
  });
});
