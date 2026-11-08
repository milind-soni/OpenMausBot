import { describe, expect, test } from "vitest";
import { effectiveExecutionPolicy, executionSelectionKey, quotaBlocksSelection, routeExecution, verificationMatchesPolicy } from "./execution-policy";
import type { ExecutionAccount, ExecutionHost, ExecutionPolicyOverride, ExecutionQuotaWindow, ExecutionSelection, ExecutionVerification } from "./execution-types";

const now = Date.UTC(2026, 10, 8, 12);
const first: ExecutionSelection = { accountId: "subscription", harness: "codex", model: "model-primary", effort: "high" };
const second: ExecutionSelection = { accountId: "backup", harness: "claude-code", model: "model-backup", effort: "medium" };
function host(id = "local", patch: Partial<ExecutionHost> = {}): ExecutionHost {
  return { id, teamId: "team", ownerId: "owner", name: id, kind: "nixos", platform: "linux", status: "online", online: true, paused: false, revoked: false, lastSeenAt: now, version: "1.0.0", capabilities: ["codex", "claude-code"], accountIds: [first.accountId, second.accountId], projectIds: ["project"], activeRunIds: [], capacity: 1, ...patch };
}
function account(selection = first, patch: Partial<ExecutionAccount> = {}): ExecutionAccount {
  const hostIds = patch.hostIds ?? ["local", "other", "cloud", "mac"];
  const models = patch.models ?? [{ id: selection.model, efforts: [selection.effort!] }];
  const harnesses = patch.harnesses ?? [selection.harness];
  return { id: selection.accountId, ownerId: "owner", identityHash: `identity-${selection.accountId}`, provider: "fixture-provider", label: selection.accountId, authKind: "subscription", authenticated: true, harnesses, models, hostIds, bindings: Object.fromEntries(hostIds.map(id => [id, [{ accountId: `profile-${id}`, authKind: patch.authKind ?? "subscription", authenticated: true, harnesses, models }]])), updatedAt: now, quota: { status: "available", observedAt: now, windows: [] }, ...patch };
}
function route(hosts: ExecutionHost[], override: ExecutionPolicyOverride = {}, accounts = [account(), account(second)], attempted: string[] = []) {
  return routeExecution({ policy: effectiveExecutionPolicy({ fallback: [first, second], cloudEnabled: true }, override), projectId: "project", ownerId: "owner", hosts, accounts, attempted, now });
}
const offline: Partial<ExecutionHost> = { online: false, lastSeenAt: now - 45001, presenceObservedAt: now };
const cloud = () => host("cloud", { kind: "boxd" });

 describe("local-first routing", () => {
  test("task overrides project overrides workspace without merging fallback arrays", () => {
    const workspace = { machine: "local", fallback: [first], reservePercent: 5, timeoutSeconds: 600 };
    const project = { fallback: [second], reservePercent: 15, timeoutSeconds: 1200 };
    const task = { timeoutSeconds: 1800 };
    const policy = effectiveExecutionPolicy(workspace, project, task);
    expect(routeExecution({ policy, hosts: [host()], accounts: [account(), account(second)], ownerId: "owner", projectId: "project", now }).selection).toEqual(second);
    expect(policy).toMatchObject({ machine: "local", reservePercent: 15, timeoutSeconds: 1800 });
    expect(effectiveExecutionPolicy(workspace, project, { fallback: [] }).fallback).toEqual([]);
    expect(workspace.fallback).toEqual([first]);
  });

  test.each<[string, Partial<ExecutionHost>]>([
    ["busy", { activeRunIds: ["running"] }], ["paused", { paused: true }],
    ["unknown presence", { online: null, lastSeenAt: now - 60000 }],
    ["lost heartbeat without independent observation", { online: false, lastSeenAt: now - 60000 }],
    ["expired tailnet observation", { ...offline, presenceObservedAt: now - 120001 }],
    ["offline observation contradicted by fresh heartbeat", { ...offline, lastSeenAt: now }],
    ["missing CLI", { capabilities: [] }], ["missing local account", { accountIds: [] }],
  ])("%s never authorizes cloud spending", (_label, patch) => {
    const result = route([host("local", patch), cloud()]);
    expect(result.host).toBeUndefined();
    expect(result.needsCloud).toBe(false);
  });

  test("every eligible local machine needs fresh independent offline evidence", () => {
    expect(route([host("local", offline), host("other", { paused: true }), cloud()]).needsCloud).toBe(false);
    expect(route([host("local", offline), host("other", offline), cloud()]).host?.id).toBe("cloud");
    expect(route([host("local", offline)]).needsCloud).toBe(true);
    expect(route([cloud()]).needsCloud).toBe(false);
    expect(route([host("local", offline), cloud()], { cloudEnabled: false }).host).toBeUndefined();
  });

  test("an explicit destination stays pinned even when offline or busy", () => {
    for (const patch of [offline, { activeRunIds: ["running"] }]) {
      const result = route([host("local", patch), host("other"), cloud()], { machine: "local" });
      expect(result.host).toBeUndefined();
      expect(result.needsCloud).toBe(false);
    }
    expect(route([host("local", offline), cloud()], { machine: "missing" }).needsCloud).toBe(false);
    expect(route([host("local", offline), cloud(), host("other", { kind: "boat" })], { machine: "other", cloudProvider: "boxd" }).host).toBeUndefined();
  });

  test("Apple work never uses Linux and portable work does not silently consume a Mac", () => {
    const mac = host("mac", { kind: "mac", platform: "darwin" });
    expect(route([host(), mac], { platform: "apple" }).host?.id).toBe("mac");
    expect(route([host(), { ...mac, ...offline }, cloud()], { platform: "apple" })).toMatchObject({ needsCloud: false });
    expect(route([host(), { ...mac, ...offline }, cloud()], { platform: "apple" }).host).toBeUndefined();
    expect(route([host(), mac], { platform: "apple", machine: "local" }).host).toBeUndefined();
    expect(route([mac]).host).toBeUndefined();
    expect(route([mac], { machine: "mac" }).host?.id).toBe("mac");
  });

  test.each<[string, Partial<ExecutionHost>]>([
    ["another owner", { ownerId: "teammate" }], ["another project", { projectIds: ["private"] }], ["revoked host", { revoked: true }],
  ])("%s cannot execute the requester's subscription", (_label, patch) => {
    expect(route([host("local", patch)]).host).toBeUndefined();
  });
});

describe("quota telemetry and exact selection priority", () => {
  const exhausted: ExecutionQuotaWindow = { id: "shared", label: "Shared subscription", scope: "account", usedPercent: 100, resetsAt: now + 60000 };
  test.each<[string, ExecutionQuotaWindow, boolean]>([
    ["shared account", exhausted, true],
    ["selected model", { ...exhausted, scope: "model", modelIds: [first.model] }, true],
    ["different model", { ...exhausted, scope: "model", modelIds: [second.model] }, false],
    ["feature-only", { ...exhausted, scope: "feature" }, false],
    ["unknown bucket", { ...exhausted, scope: "unknown" }, false],
    ["unclassified vendor bucket", { ...exhausted, scope: undefined }, false],
    ["known legacy shared bucket", { ...exhausted, id: "codex.primary", scope: undefined }, true],
    ["already reset", { ...exhausted, resetsAt: now }, false],
  ])("%s only skips an actually exhausted applicable selection", (_label, window, blocked) => {
    const primary = account(first, { quota: { status: "available", observedAt: now, windows: [window] } });
    expect(quotaBlocksSelection(primary, first, 0, now)).toBe(blocked);
    expect(route([host()], {}, [primary, account(second)]).selection).toEqual(blocked ? second : first);
  });

  test.each(["unknown", "stale", "error"] as const)("%s meters do not masquerade as exhaustion", status => {
    const primary = account(first, { quota: { status, observedAt: now, windows: [exhausted] } });
    expect(route([host()], {}, [primary, account(second)]).selection).toEqual(first);
  });
  test.each([now - 300001, now + 60001])("untrustworthy observation timestamp %i cannot skip an account", observedAt => {
    expect(route([host()], {}, [account(first, { quota: { status: "available", observedAt, windows: [exhausted] } }), account(second)]).selection).toEqual(first);
  });
  test("reserve is inclusive, shared windows constrain models, and reset windows do not", () => {
    const primary = account(first, { quota: { status: "available", observedAt: now, windows: [{ ...exhausted, usedPercent: 80 }, { ...exhausted, scope: "feature" }] } });
    expect(route([host()], { reservePercent: 19 }, [primary, account(second)]).selection).toEqual(first);
    expect(route([host()], { reservePercent: 20 }, [primary, account(second)]).selection).toEqual(second);
    expect(route([host()], { fallbackMode: "disabled", reservePercent: 20 }, [primary, account(second)]).selection).toBeUndefined();
  });

  test("selection priority precedes host order and attempted keys include model and effort", () => {
    const otherModel = { ...first, model: "model-alternative", effort: "low" };
    const primary = account(first, { hostIds: ["other"], models: [{ id: first.model, efforts: ["high", "low"] }, { id: otherModel.model, efforts: ["low"] }] });
    expect(route([host(), host("other")], {}, [primary, account(second)]).selection).toEqual(first);
    expect(route([host(), host("other")], {}, [primary, account(second)]).host?.id).toBe("other");
    expect(route([host("other")], { fallback: [first, otherModel] }, [primary], [executionSelectionKey(first)]).selection).toEqual(otherModel);
    expect(route([host("other")], { fallback: [first, { ...first, effort: "low" }] }, [primary], [executionSelectionKey(first)]).selection?.effort).toBe("low");
  });

  test("paid API, cross-harness changes and different owners require explicit authorization", () => {
    const paid = account(first, { authKind: "api" });
    expect(route([host()], {}, [paid, account(second)]).selection).toEqual(second);
    expect(route([host()], { allowPaidApi: true }, [paid, account(second)]).selection).toEqual(first);
    expect(route([host()], { allowCrossHarness: false }, [paid, account(second)]).selection).toBeUndefined();
    expect(route([host()], {}, [account(first, { ownerId: "teammate" }), account(second)]).selection).toEqual(second);
    expect(route([host()], {}, [account(first, { models: [{ id: "not-the-requested-model" }] }), account(second)]).selection).toEqual(second);
    expect(route([host()], {}, [account(first, { models: [{ id: first.model, efforts: ["low"] }] }), account(second)]).selection).toEqual(second);
  });

  test("a subscription on another machine cannot authorize a paid local profile", () => {
    const primary = account();
    primary.bindings!.local![0]!.authKind = "api";
    expect(route([host(), host("other")], {}, [primary]).host?.id).toBe("other");
    expect(route([host()], {}, [primary, account(second)]).selection).toEqual(second);
    expect(route([host()], { allowPaidApi: true }, [primary]).selection).toEqual(first);
  });

  test("unknown billing is not included subscription usage or approved API use", () => {
    const primary = account(first, { authKind: "unknown" });
    expect(route([host()], {}, [primary, account(second)]).selection).toEqual(second);
    expect(route([host()], { allowPaidApi: true }, [primary, account(second)]).selection).toEqual(second);
  });

  test.each(["signed out", "wrong harness", "wrong model", "wrong effort"])("a %s host binding cannot borrow another machine's account metadata", problem => {
    const binding = { accountId: "local-profile", authKind: "subscription" as const, authenticated: problem !== "signed out", harnesses: problem === "wrong harness" ? ["claude-code" as const] : ["codex" as const], models: [{ id: problem === "wrong model" ? "other-model" : first.model, efforts: [problem === "wrong effort" ? "low" : "high"] }] };
    const primary = account(first, { bindings: { local: [binding], other: [{ accountId: "working-profile", authKind: "subscription", authenticated: true, harnesses: ["codex"], models: [{ id: first.model, efforts: ["high"] }] }] } });
    expect(route([host(), host("other")], {}, [primary, account(second)]).host?.id).toBe("other");
  });
});

describe("configured merge receipts", () => {
  const policy = effectiveExecutionPolicy({ verificationCommands: ["npm test", "npm run typecheck"], smokeCommand: "npm run smoke" });
  const receipts: ExecutionVerification[] = [{ command: "npm test", kind: "test", exitCode: 0 }, { command: "npm run typecheck", kind: "test", exitCode: 0 }, { command: "npm run smoke", kind: "smoke", exitCode: 0 }];
  test("only all exact successful configured receipts satisfy the gate", () => {
    expect(verificationMatchesPolicy(policy, receipts)).toBe(true);
    for (const altered of [receipts.slice(0, 2), [...receipts, receipts[0]!], [receipts[1]!, receipts[0]!, receipts[2]!], receipts.map((receipt, i) => i === 0 ? { ...receipt, exitCode: 1 } : receipt), receipts.map((receipt, i) => i === 2 ? { ...receipt, kind: "test" as const } : receipt), receipts.map((receipt, i) => i === 0 ? { ...receipt, command: "echo tests-passed" } : receipt)]) {
      expect(verificationMatchesPolicy(policy, altered)).toBe(false);
    }
    expect(verificationMatchesPolicy(effectiveExecutionPolicy(), [])).toBe(false);
  });
});

